import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import type { PowerSyncDatabase, WatchedQuery } from "@powersync/node";
import {
  APP_TABLES,
  DEFAULT_CONVERSATION_TITLE,
  OPERATION_EVENT_TYPE,
  DEVICE_PAIRING_STATUS,
  DEVICE_OPERATION_STATUS,
  DEVICE_OPERATION_TYPE,
  DEVICE_STATUS,
  MESSAGE_ROLE,
  MESSAGE_SOURCE,
  parseMessageContent,
  serializeMessageContent,
  truncateTitle,
  type AppDatabase
} from "@synced-lm-studio/shared";
import { bridgeConfig } from "./config";
import { listModels, runChat } from "./lm-studio";
import {
  materializeConversationFile,
  readConversationFile,
  type ImportedConversationFile,
  type ImportedConversationFileMessage
} from "./sidebar";

type Database = PowerSyncDatabase;
type DeviceRow = AppDatabase["devices"];
type ConversationRow = AppDatabase["conversations"];
type MessageRow = AppDatabase["messages"];
type DeviceOperationRow = AppDatabase["device_operations"];
type LmThreadRow = AppDatabase["lmstudio_threads"];

type SendMessagePayload = {
  user_message_id?: string;
  model_identifier?: string;
  reasoning?: "off" | "low" | "medium" | "high" | "on";
  materialize_sidebar?: boolean;
};

type ComparableMessage = {
  role: string;
  text: string;
};

type ConversationFileState = {
  observedMtimeMs: number;
  importedMtimeMs: number;
  missingSinceMs: number | null;
};

const MISSING_CONVERSATION_DELETE_GRACE_MS = 2_000;
const CONVERSATION_WATCH_DEBOUNCE_MS = 250;
const CONVERSATION_SWEEP_INTERVAL_MS = 60_000;

function isoNow() {
  return new Date().toISOString();
}

function generatePairingCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function estimateTokenCount(text: string) {
  return Math.max(8, Math.ceil(text.length / 4));
}

function ensureJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class BridgeService {
  private deviceId: string | null = null;
  private devicePairingStatus: string = DEVICE_PAIRING_STATUS.pending;
  private lastModelsRefresh = 0;
  private lastHeartbeatAt = 0;
  private lastConversationSweepAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private conversationWatcher: FSWatcher | null = null;
  private conversationSyncTimer: NodeJS.Timeout | null = null;
  private conversationSyncDueAt = 0;
  private conversationSyncRequested = false;
  private readonly conversationDeleteTimers = new Map<string, NodeJS.Timeout>();
  private isTicking = false;
  private tickQueued = false;
  private pendingOperationWatch: WatchedQuery<ReadonlyArray<Readonly<DeviceOperationRow>>> | null =
    null;
  private pendingOperationWatchDispose: (() => void) | null = null;
  private pendingOperationWatchChain: Promise<void> = Promise.resolve();
  private readonly conversationFileStates = new Map<string, ConversationFileState>();
  private conversationDirectoryAvailable: boolean | null = null;
  private announcedPairingStateKey: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly ownerUserId: string
  ) {}

  async start() {
    console.log("[bridge] Starting bridge service");
    await this.ensureDeviceRow();
    console.log("[bridge] Device row ready", { deviceId: this.deviceId });
    const initialRefreshSucceeded = await this.refreshModels({
      allowFailure: true,
      reason: "startup"
    });
    console.log(
      initialRefreshSucceeded
        ? "[bridge] Initial model refresh complete"
        : "[bridge] Initial model refresh deferred until the LM Studio API is reachable"
    );
    await this.startPendingOperationWatch();
    await this.startConversationWatcher();
    await this.tick();
    this.timer = setInterval(() => {
      this.requestTick();
    }, bridgeConfig.pollIntervalMs);
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.conversationSyncTimer) {
      clearTimeout(this.conversationSyncTimer);
      this.conversationSyncTimer = null;
      this.conversationSyncDueAt = 0;
    }
    if (this.conversationWatcher) {
      await this.conversationWatcher.close();
      this.conversationWatcher = null;
    }
    if (this.pendingOperationWatchDispose) {
      this.pendingOperationWatchDispose();
      this.pendingOperationWatchDispose = null;
    }
    if (this.pendingOperationWatch) {
      await this.pendingOperationWatch.close();
      this.pendingOperationWatch = null;
    }
    for (const timer of this.conversationDeleteTimers.values()) {
      clearTimeout(timer);
    }
    this.conversationDeleteTimers.clear();

    if (!this.deviceId) {
      return;
    }

    await this.db.execute(
      `
        UPDATE ${APP_TABLES.devices}
        SET status = ?, last_seen_at = ?, updated_at = ?
        WHERE id = ?
      `,
      [DEVICE_STATUS.offline, isoNow(), isoNow(), this.deviceId]
    );
  }

  private async startPendingOperationWatch() {
    if (this.pendingOperationWatch || !this.deviceId) {
      return;
    }

    const watchedQuery = this.db
      .query<DeviceOperationRow>({
        sql: `
          SELECT *
          FROM ${APP_TABLES.deviceOperations}
          WHERE device_id = ?
            AND type = ?
            AND status IN (?, ?)
          ORDER BY created_at ASC
          LIMIT 20
        `,
        parameters: [
          this.deviceId,
          DEVICE_OPERATION_TYPE.sendMessage,
          DEVICE_OPERATION_STATUS.pending,
          DEVICE_OPERATION_STATUS.running
        ]
      })
      .watch({
        triggerOnTables: [APP_TABLES.deviceOperations, APP_TABLES.messages],
        reportFetching: false,
        throttleMs: 10
      });

    this.pendingOperationWatch = watchedQuery;
    this.pendingOperationWatchDispose = watchedQuery.registerListener({
      onData: (operations) => {
        this.pendingOperationWatchChain = this.pendingOperationWatchChain
          .then(async () => {
            await this.recordBridgeMessageSeenEvents(operations);
            if (operations.length > 0) {
              this.requestTick();
            }
          })
          .catch((error) => {
            console.error("[bridge] Failed to record bridge message receipt benchmark", {
              error: error instanceof Error ? error.message : String(error)
            });
          });
      },
      onError: (error) => {
        console.error("[bridge] Pending operation watch failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      },
      closed: () => {
        this.pendingOperationWatch = null;
        this.pendingOperationWatchDispose = null;
      }
    });

    await this.recordBridgeMessageSeenEvents(watchedQuery.state.data);
    if (watchedQuery.state.data.length > 0) {
      this.requestTick();
    }
  }

  private requestTick() {
    if (this.isTicking) {
      this.tickQueued = true;
      return;
    }

    void this.tick();
  }

  private async recordBridgeMessageSeenEvents(
    operations: ReadonlyArray<Readonly<DeviceOperationRow>>
  ) {
    if (!this.deviceId) {
      return;
    }

    for (const operation of operations) {
      const payload = ensureJson<SendMessagePayload>(operation.payload_json, {});
      if (!payload.user_message_id) {
        continue;
      }

      const [existingEvent, userMessage] = await Promise.all([
        this.db.getOptional<{ id: string }>(
          `
            SELECT id
            FROM ${APP_TABLES.operationEvents}
            WHERE operation_id = ?
              AND event_type = ?
            LIMIT 1
          `,
          [operation.id, OPERATION_EVENT_TYPE.benchmarkBridgeMessageSeen]
        ),
        this.requireMessage(payload.user_message_id)
      ]);

      if (existingEvent || !userMessage) {
        continue;
      }

      await this.db.execute(
        `
          INSERT INTO ${APP_TABLES.operationEvents}
            (id, operation_id, device_id, event_type, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          operation.id,
          this.deviceId,
          OPERATION_EVENT_TYPE.benchmarkBridgeMessageSeen,
          JSON.stringify({
            user_message_id: userMessage.id,
            observed_operation_status: operation.status ?? null
          }),
          isoNow()
        ]
      );
    }
  }

  private async tick() {
    if (this.isTicking) {
      this.tickQueued = true;
      return;
    }

    const shouldSweepConversations =
      this.conversationSyncRequested ||
      this.lastConversationSweepAt === 0 ||
      Date.now() - this.lastConversationSweepAt >= CONVERSATION_SWEEP_INTERVAL_MS;

    this.isTicking = true;
    try {
      await this.ensureDeviceRow();
      await this.heartbeatIfDue();
      await this.refreshModelsIfDue();
      if (this.devicePairingStatus !== DEVICE_PAIRING_STATUS.paired) {
        return;
      }
      await this.processPendingOperations();
      if (shouldSweepConversations) {
        await this.reconcileLmStudioConversationFiles();
        this.lastConversationSweepAt = Date.now();
        this.conversationSyncRequested = false;
      }
    } finally {
      this.isTicking = false;
      if (this.tickQueued) {
        this.tickQueued = false;
        this.requestTick();
      }
    }
  }

  private async startConversationWatcher() {
    if (this.conversationWatcher) {
      return;
    }

    this.conversationWatcher = chokidar.watch(bridgeConfig.lmStudioConversationsDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: 750,
        pollInterval: 100
      }
    });

    this.conversationWatcher
      .on("ready", () => {
        console.log("[bridge] Watching LM Studio conversations", {
          path: bridgeConfig.lmStudioConversationsDir
        });
      })
      .on("add", (filePath) => {
        this.handleConversationWatcherFileEvent("add", filePath);
      })
      .on("change", (filePath) => {
        this.handleConversationWatcherFileEvent("change", filePath);
      })
      .on("unlink", (filePath) => {
        this.handleConversationWatcherFileEvent("unlink", filePath);
      })
      .on("addDir", (directoryPath) => {
        this.handleConversationWatcherDirectoryEvent("addDir", directoryPath);
      })
      .on("unlinkDir", (directoryPath) => {
        this.handleConversationWatcherDirectoryEvent("unlinkDir", directoryPath);
      })
      .on("error", (error) => {
        console.error("[bridge] LM Studio conversations watcher error", {
          path: bridgeConfig.lmStudioConversationsDir,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private handleConversationWatcherDirectoryEvent(
    eventType: "addDir" | "unlinkDir",
    directoryPath: string
  ) {
    if (this.resolveConversationWatcherPath(directoryPath) !== path.resolve(bridgeConfig.lmStudioConversationsDir)) {
      return;
    }

    this.conversationDirectoryAvailable = eventType === "addDir";
    if (eventType === "addDir") {
      this.queueConversationSync(0);
      return;
    }

    console.warn("[bridge] LM Studio conversations directory removed", {
      path: bridgeConfig.lmStudioConversationsDir
    });
  }

  private handleConversationWatcherFileEvent(
    eventType: "add" | "change" | "unlink",
    filePath: string
  ) {
    if (!filePath.endsWith(".conversation.json")) {
      return;
    }

    const absolutePath = this.resolveConversationWatcherPath(filePath);
    if (eventType === "unlink") {
      const nowMs = Date.now();
      const existingState = this.conversationFileStates.get(absolutePath);
      if (existingState) {
        existingState.observedMtimeMs = -1;
        existingState.missingSinceMs = nowMs;
      } else {
        this.conversationFileStates.set(absolutePath, {
          observedMtimeMs: -1,
          importedMtimeMs: -1,
          missingSinceMs: nowMs
        });
      }

      this.scheduleConversationDelete(absolutePath);
      return;
    }

    this.clearScheduledConversationDelete(absolutePath);
    const existingState = this.conversationFileStates.get(absolutePath);
    if (existingState) {
      existingState.missingSinceMs = null;
    }
    this.queueConversationSync(CONVERSATION_WATCH_DEBOUNCE_MS);
  }

  private resolveConversationWatcherPath(watchedPath: string) {
    return path.isAbsolute(watchedPath)
      ? path.resolve(watchedPath)
      : path.resolve(bridgeConfig.lmStudioConversationsDir, watchedPath);
  }

  private scheduleConversationDelete(filePath: string) {
    this.clearScheduledConversationDelete(filePath);

    const timer = setTimeout(() => {
      this.conversationDeleteTimers.delete(filePath);
      void this.deleteConversationForMissingPath(filePath);
    }, MISSING_CONVERSATION_DELETE_GRACE_MS);

    this.conversationDeleteTimers.set(filePath, timer);
  }

  private clearScheduledConversationDelete(filePath: string) {
    const timer = this.conversationDeleteTimers.get(filePath);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.conversationDeleteTimers.delete(filePath);
  }

  private async deleteConversationForMissingPath(filePath: string) {
    if (!this.deviceId) {
      return;
    }

    try {
      await fs.stat(filePath);
      return;
    } catch (error) {
      const isMissing =
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT";

      if (!isMissing) {
        throw error;
      }
    }

    const cacheFilename = path.basename(filePath);
    const thread = await this.db.getOptional<LmThreadRow>(
      `
        SELECT *
        FROM ${APP_TABLES.lmstudioThreads}
        WHERE device_id = ?
          AND cache_filename = ?
        LIMIT 1
      `,
      [this.deviceId, cacheFilename]
    );

    if (!thread) {
      this.conversationFileStates.delete(filePath);
      return;
    }

    await this.deleteConversationForMissingFile(thread);
    this.conversationFileStates.delete(filePath);
  }

  private queueConversationSync(delayMs: number) {
    this.conversationSyncRequested = true;
    const nextDueAt = Date.now() + delayMs;

    if (this.conversationSyncTimer && this.conversationSyncDueAt <= nextDueAt) {
      return;
    }

    if (this.conversationSyncTimer) {
      clearTimeout(this.conversationSyncTimer);
    }

    this.conversationSyncDueAt = nextDueAt;
    this.conversationSyncTimer = setTimeout(() => {
      this.conversationSyncTimer = null;
      this.conversationSyncDueAt = 0;
      this.requestTick();
    }, Math.max(0, nextDueAt - Date.now()));
  }

  private async ensureDeviceRow() {
    const now = isoNow();
    const metadataJson = JSON.stringify({ hostname: process.env.HOSTNAME ?? null });
    const existing = await this.db.getOptional<DeviceRow>(
      `SELECT * FROM ${APP_TABLES.devices} WHERE machine_key = ?`,
      [bridgeConfig.bridgeMachineKey]
    );

    if (existing) {
      const ownerChanged = existing.owner_user_id !== this.ownerUserId;
      const pairingStatus = ownerChanged
        ? DEVICE_PAIRING_STATUS.pending
        : existing.pairing_status ?? DEVICE_PAIRING_STATUS.pending;
      const pairingCode =
        pairingStatus === DEVICE_PAIRING_STATUS.paired
          ? null
          : ownerChanged || !existing.pairing_code
            ? generatePairingCode()
            : existing.pairing_code;
      const pairedAt =
        pairingStatus === DEVICE_PAIRING_STATUS.paired ? existing.paired_at ?? now : null;

      this.deviceId = existing.id;
      this.devicePairingStatus = pairingStatus;
      const needsUpdate =
        ownerChanged ||
        existing.display_name !== bridgeConfig.bridgeDeviceName ||
        (existing.pairing_status ?? DEVICE_PAIRING_STATUS.pending) !== pairingStatus ||
        (existing.pairing_code ?? null) !== pairingCode ||
        (existing.platform ?? null) !== process.platform ||
        (existing.bridge_version ?? null) !== bridgeConfig.bridgeVersion ||
        (existing.metadata_json ?? null) !== metadataJson ||
        (existing.paired_at ?? null) !== pairedAt;

      if (needsUpdate) {
        await this.db.execute(
          `
            UPDATE ${APP_TABLES.devices}
            SET owner_user_id = ?, display_name = ?, pairing_status = ?, pairing_code = ?, platform = ?, bridge_version = ?, metadata_json = ?, paired_at = ?, updated_at = ?
            WHERE id = ?
          `,
          [
            this.ownerUserId,
            bridgeConfig.bridgeDeviceName,
            pairingStatus,
            pairingCode,
            process.platform,
            bridgeConfig.bridgeVersion,
            metadataJson,
            pairedAt,
            now,
            existing.id
          ]
        );
      }

      this.maybeAnnouncePairing(existing.id, pairingStatus, pairingCode);
      return existing.id;
    }

    const deviceId = randomUUID();
    const pairingCode = generatePairingCode();
    this.deviceId = deviceId;
    this.devicePairingStatus = DEVICE_PAIRING_STATUS.pending;

    await this.db.execute(
      `
        INSERT INTO ${APP_TABLES.devices}
          (id, owner_user_id, machine_key, display_name, status, pairing_status, pairing_code, platform, bridge_version, metadata_json, paired_at, last_seen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        deviceId,
        this.ownerUserId,
        bridgeConfig.bridgeMachineKey,
        bridgeConfig.bridgeDeviceName,
        DEVICE_STATUS.online,
        DEVICE_PAIRING_STATUS.pending,
        pairingCode,
        process.platform,
        bridgeConfig.bridgeVersion,
        metadataJson,
        null,
        now,
        now,
        now
      ]
    );

    this.maybeAnnouncePairing(deviceId, DEVICE_PAIRING_STATUS.pending, pairingCode);
    return deviceId;
  }

  private async heartbeatIfDue() {
    if (!this.deviceId) {
      return;
    }

    const nowMs = Date.now();
    if (
      this.lastHeartbeatAt !== 0 &&
      nowMs - this.lastHeartbeatAt < bridgeConfig.heartbeatIntervalMs
    ) {
      return;
    }

    const now = isoNow();
    await this.db.execute(
      `
        UPDATE ${APP_TABLES.devices}
        SET status = ?, last_seen_at = ?, updated_at = ?
        WHERE id = ?
      `,
      [DEVICE_STATUS.online, now, now, this.deviceId]
    );
    this.lastHeartbeatAt = nowMs;
  }

  private async refreshModelsIfDue() {
    if (Date.now() - this.lastModelsRefresh < bridgeConfig.modelsRefreshIntervalMs) {
      return;
    }

    await this.refreshModels({
      allowFailure: true,
      reason: "background refresh"
    });
  }

  private async refreshModels(options?: {
    allowFailure?: boolean;
    reason?: string;
  }) {
    if (!this.deviceId) {
      return false;
    }

    try {
      const models = await listModels();
      const now = isoNow();
      const modelIdentifiers = models.map((model) => model.identifier);

      await this.db.writeTransaction(async (tx) => {
        for (const model of models) {
          const existing = await tx.getOptional<{
            id: string;
            display_name: string | null;
            is_loaded: number | null;
            state: string | null;
          }>(
            `
              SELECT id, display_name, is_loaded, state
              FROM ${APP_TABLES.deviceModels}
              WHERE device_id = ? AND model_identifier = ?
            `,
            [this.deviceId, model.identifier]
          );

          if (existing) {
            if (
              existing.display_name !== model.displayName ||
              (existing.is_loaded ?? 0) !== (model.isLoaded ? 1 : 0) ||
              (existing.state ?? null) !== model.state
            ) {
              await tx.execute(
                `
                  UPDATE ${APP_TABLES.deviceModels}
                  SET display_name = ?, is_loaded = ?, state = ?, updated_at = ?
                  WHERE id = ?
                `,
                [model.displayName, model.isLoaded ? 1 : 0, model.state, now, existing.id]
              );
            }
            continue;
          }

          await tx.execute(
            `
              INSERT INTO ${APP_TABLES.deviceModels}
                (id, device_id, model_identifier, display_name, is_loaded, state, discovered_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
              randomUUID(),
              this.deviceId,
              model.identifier,
              model.displayName,
              model.isLoaded ? 1 : 0,
              model.state,
              now,
              now
            ]
          );
        }

        const placeholders = modelIdentifiers.map(() => "?").join(", ");
        await tx.execute(
          `
            DELETE FROM ${APP_TABLES.deviceModels}
            WHERE device_id = ?
              ${placeholders ? `AND model_identifier NOT IN (${placeholders})` : ""}
          `,
          [this.deviceId, ...modelIdentifiers]
        );
      });

      this.lastModelsRefresh = Date.now();
      return true;
    } catch (error) {
      if (!options?.allowFailure) {
        throw error;
      }

      this.lastModelsRefresh = Date.now();
      console.warn("[bridge] Skipping model refresh", {
        reason: options.reason ?? "unknown",
        lmStudioBaseUrl: bridgeConfig.lmStudioBaseUrl,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  private async processPendingOperations() {
    if (!this.deviceId) {
      return;
    }

    const operations = await this.db.getAll<DeviceOperationRow>(
      `
        SELECT *
        FROM ${APP_TABLES.deviceOperations}
        WHERE device_id = ?
          AND status IN (?, ?)
        ORDER BY created_at ASC
        LIMIT 10
      `,
      [this.deviceId, DEVICE_OPERATION_STATUS.pending, DEVICE_OPERATION_STATUS.running]
    );

    for (const operation of operations) {
      try {
        if (operation.status !== DEVICE_OPERATION_STATUS.running) {
          await this.markOperationRunning(operation.id);
        }

        if (operation.type === DEVICE_OPERATION_TYPE.refreshModels) {
          await this.refreshModels();
          await this.markOperationCompleted(operation.id, {
            refreshed_at: isoNow()
          });
          continue;
        }

        if (operation.type === DEVICE_OPERATION_TYPE.sendMessage) {
          await this.handleSendMessage(operation);
          continue;
        }

        await this.markOperationFailed(operation.id, `Unsupported operation type: ${operation.type}`);
      } catch (error) {
        await this.markOperationFailed(
          operation.id,
          error instanceof Error ? error.message : "Unknown operation error"
        );
      }
    }
  }

  private async reconcileLmStudioConversationFiles() {
    if (!this.deviceId) {
      return;
    }
    if (!(await this.isConversationDirectoryAvailable())) {
      return;
    }

    let threads = await this.db.getAll<LmThreadRow>(
      `
        SELECT *
        FROM ${APP_TABLES.lmstudioThreads}
        WHERE device_id = ?
          AND cache_filename IS NOT NULL
          AND cache_filename <> ''
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 100
      `,
      [this.deviceId]
    );
    const knownCacheFilenames = new Set(
      threads
        .map((thread) => thread.cache_filename)
        .filter((cacheFilename): cacheFilename is string => typeof cacheFilename === "string" && cacheFilename.length > 0)
    );
    const discoveredCount = await this.discoverLmStudioConversationFiles(knownCacheFilenames);
    if (discoveredCount > 0) {
      threads = await this.db.getAll<LmThreadRow>(
        `
          SELECT *
          FROM ${APP_TABLES.lmstudioThreads}
          WHERE device_id = ?
            AND cache_filename IS NOT NULL
            AND cache_filename <> ''
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 100
        `,
        [this.deviceId]
      );
    }

    for (const thread of threads) {
      try {
        await this.reconcileLmStudioConversationFile(thread);
      } catch (error) {
        console.error("[bridge] Failed to reconcile LM Studio conversation file", {
          conversationId: thread.conversation_id,
          cacheFilename: thread.cache_filename,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private async isConversationDirectoryAvailable() {
    try {
      const stat = await fs.stat(bridgeConfig.lmStudioConversationsDir);
      const available = stat.isDirectory();
      if (this.conversationDirectoryAvailable !== available) {
        this.conversationDirectoryAvailable = available;
        if (available) {
          console.log("[bridge] LM Studio conversations directory available", {
            path: bridgeConfig.lmStudioConversationsDir
          });
        } else {
          console.warn("[bridge] LM Studio conversations path is not a directory; skipping sync", {
            path: bridgeConfig.lmStudioConversationsDir
          });
        }
      }

      return available;
    } catch (error) {
      const isMissing =
        error &&
        typeof error === "object" &&
        "code" in error &&
        ((error as NodeJS.ErrnoException).code === "ENOENT" ||
          (error as NodeJS.ErrnoException).code === "ENOTDIR");

      if (isMissing) {
        if (this.conversationDirectoryAvailable !== false) {
          this.conversationDirectoryAvailable = false;
          console.warn("[bridge] LM Studio conversations directory unavailable; skipping sync", {
            path: bridgeConfig.lmStudioConversationsDir
          });
        }
        return false;
      }

      throw error;
    }
  }

  private async discoverLmStudioConversationFiles(knownCacheFilenames: Set<string>) {
    let entries: string[];
    try {
      entries = await fs.readdir(bridgeConfig.lmStudioConversationsDir);
    } catch (error) {
      const isMissing =
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT";

      if (isMissing) {
        return 0;
      }

      throw error;
    }

    let discoveredCount = 0;
    const cacheFilenames = entries
      .filter((entry) => entry.endsWith(".conversation.json"))
      .sort();

    for (const cacheFilename of cacheFilenames) {
      if (knownCacheFilenames.has(cacheFilename)) {
        continue;
      }

      try {
        const imported = await this.importNewConversationFile(cacheFilename);
        if (!imported) {
          continue;
        }

        knownCacheFilenames.add(cacheFilename);
        discoveredCount += 1;
      } catch (error) {
        console.error("[bridge] Failed to import LM Studio conversation file", {
          cacheFilename,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return discoveredCount;
  }

  private async reconcileLmStudioConversationFile(thread: LmThreadRow) {
    if (!thread.cache_filename) {
      return;
    }

    const filePath = path.join(bridgeConfig.lmStudioConversationsDir, thread.cache_filename);

    let fileStat;
    try {
      fileStat = await fs.stat(filePath);
    } catch (error) {
      const isMissing =
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT";

      if (isMissing) {
        const nowMs = Date.now();
        const missingState = this.conversationFileStates.get(filePath);
        if (!missingState) {
          this.conversationFileStates.set(filePath, {
            observedMtimeMs: -1,
            importedMtimeMs: -1,
            missingSinceMs: nowMs
          });
          return;
        }

        if (missingState.missingSinceMs == null) {
          missingState.missingSinceMs = nowMs;
          return;
        }

        if (nowMs - missingState.missingSinceMs < MISSING_CONVERSATION_DELETE_GRACE_MS) {
          return;
        }

        await this.deleteConversationForMissingFile(thread);
        this.conversationFileStates.delete(filePath);
        return;
      }

      throw error;
    }

    const mtimeMs = Math.trunc(fileStat.mtimeMs);
    const existingState = this.conversationFileStates.get(filePath);

    if (!existingState) {
      this.conversationFileStates.set(filePath, {
        observedMtimeMs: mtimeMs,
        importedMtimeMs: -1,
        missingSinceMs: null
      });
    } else {
      existingState.missingSinceMs = null;
      if (existingState.observedMtimeMs !== mtimeMs) {
        existingState.observedMtimeMs = mtimeMs;
        return;
      }
    }

    const fileState = this.conversationFileStates.get(filePath);
    if (!fileState || fileState.importedMtimeMs === mtimeMs) {
      return;
    }

    const imported = await readConversationFile(filePath);
    await this.importConversationFile(thread, imported, mtimeMs);

    fileState.observedMtimeMs = mtimeMs;
    fileState.importedMtimeMs = mtimeMs;
  }

  private async importNewConversationFile(cacheFilename: string) {
    if (!this.deviceId) {
      return false;
    }

    const existing = await this.db.getOptional<{ id: string }>(
      `
        SELECT id
        FROM ${APP_TABLES.lmstudioThreads}
        WHERE device_id = ?
          AND cache_filename = ?
        LIMIT 1
      `,
      [this.deviceId, cacheFilename]
    );
    if (existing) {
      return false;
    }

    const filePath = path.join(bridgeConfig.lmStudioConversationsDir, cacheFilename);
    const fileStat = await fs.stat(filePath);
    const imported = await readConversationFile(filePath);
    if (!imported) {
      return false;
    }

    const mtimeMs = Math.trunc(fileStat.mtimeMs);
    const createdAtMs = imported.createdAtMs ?? mtimeMs;
    const createdAt = new Date(createdAtMs).toISOString();
    const syncTimestamp = new Date(mtimeMs).toISOString();
    const conversationId = randomUUID();
    const threadId = randomUUID();
    const title = imported.title || DEFAULT_CONVERSATION_TITLE;
    const importedMessages = this.buildImportedMessages({
      tail: imported.messages,
      baselineMessages: [],
      fallbackModelIdentifier: imported.modelIdentifier,
      importedAtMs: createdAtMs + 1000,
      conversationId
    });
    const lastMessageAt =
      imported.lastActivityAtMs != null
        ? new Date(imported.lastActivityAtMs).toISOString()
        : importedMessages[importedMessages.length - 1]?.created_at ?? createdAt;

    await this.db.writeTransaction(async (tx) => {
      await tx.execute(
        `
          INSERT INTO ${APP_TABLES.conversations}
            (id, owner_user_id, target_device_id, title, status, metadata_json, created_at, updated_at, last_message_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          conversationId,
          this.ownerUserId,
          this.deviceId,
          title,
          "active",
          JSON.stringify({
            origin: "lmstudio",
            cache_filename: cacheFilename
          }),
          createdAt,
          lastMessageAt,
          importedMessages.length > 0 ? lastMessageAt : null
        ]
      );

      for (const message of importedMessages) {
        await tx.execute(
          `
            INSERT INTO ${APP_TABLES.messages}
              (id, conversation_id, role, content_json, source, model_identifier, token_count, lmstudio_response_id, error_text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            message.id,
            message.conversation_id,
            message.role,
            message.content_json,
            message.source,
            message.model_identifier,
            message.token_count,
            null,
            null,
            message.created_at,
            message.updated_at
          ]
        );
      }

      await tx.execute(
        `
          INSERT INTO ${APP_TABLES.lmstudioThreads}
            (id, conversation_id, device_id, current_response_id, model_identifier, cache_filename, last_synced_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          threadId,
          conversationId,
          this.deviceId,
          null,
          imported.modelIdentifier,
          cacheFilename,
          syncTimestamp,
          createdAt,
          syncTimestamp
        ]
      );
    });

    this.conversationFileStates.set(filePath, {
      observedMtimeMs: mtimeMs,
      importedMtimeMs: mtimeMs,
      missingSinceMs: null
    });

    console.log("[bridge] Imported new LM Studio conversation", {
      conversationId,
      cacheFilename,
      title,
      messageCount: importedMessages.length
    });
    return true;
  }

  private async deleteConversationForMissingFile(thread: LmThreadRow) {
    const operationIds = await this.db.getAll<{ id: string }>(
      `
        SELECT id
        FROM ${APP_TABLES.deviceOperations}
        WHERE conversation_id = ?
      `,
      [thread.conversation_id]
    );

    await this.db.writeTransaction(async (tx) => {
      for (const operation of operationIds) {
        await tx.execute(
          `
            DELETE FROM ${APP_TABLES.operationEvents}
            WHERE operation_id = ?
          `,
          [operation.id]
        );
      }

      await tx.execute(
        `
          DELETE FROM ${APP_TABLES.deviceOperations}
          WHERE conversation_id = ?
        `,
        [thread.conversation_id]
      );

      await tx.execute(
        `
          DELETE FROM ${APP_TABLES.messages}
          WHERE conversation_id = ?
        `,
        [thread.conversation_id]
      );

      await tx.execute(
        `
          DELETE FROM ${APP_TABLES.lmstudioThreads}
          WHERE conversation_id = ?
        `,
        [thread.conversation_id]
      );

      await tx.execute(
        `
          DELETE FROM ${APP_TABLES.conversations}
          WHERE id = ?
        `,
        [thread.conversation_id]
      );
    });

    console.log("[bridge] Deleted canonical conversation for removed LM Studio file", {
      conversationId: thread.conversation_id,
      cacheFilename: thread.cache_filename
    });
  }

  private async handleSendMessage(operation: DeviceOperationRow) {
    const payload = ensureJson<SendMessagePayload>(operation.payload_json, {});
    const conversation = await this.requireConversation(operation.conversation_id);
    const userMessage = payload.user_message_id
      ? await this.requireMessage(payload.user_message_id)
      : await this.getLatestUserMessage(conversation.id);

    if (!userMessage) {
      throw new Error("No user message found for send_message operation");
    }

    const thread = await this.db.getOptional<LmThreadRow>(
      `SELECT * FROM ${APP_TABLES.lmstudioThreads} WHERE conversation_id = ?`,
      [conversation.id]
    );

    const modelIdentifier =
      payload.model_identifier ??
      thread?.model_identifier ??
      (await this.getPreferredModelIdentifier()) ??
      "qwen/qwen3-vl-8b";

    const assistantMessageId = randomUUID();
    const assistantCreatedAt = isoNow();
    const currentTitle = conversation.title ?? DEFAULT_CONVERSATION_TITLE;
    const nextTitle =
      currentTitle === DEFAULT_CONVERSATION_TITLE
        ? truncateTitle(parseMessageContent(userMessage.content_json).text)
        : currentTitle;
    const cacheFilename =
      thread?.cache_filename ??
      `${Date.parse(conversation.created_at || assistantCreatedAt) || Date.now()}.conversation.json`;

    let streamedText = "";
    let streamedReasoningText = "";
    let assistantInserted = false;
    let flushTimer: NodeJS.Timeout | null = null;
    let flushChain = Promise.resolve();
    let finalOutputTokens: number | null = null;

    const flushAssistantMessage = async (force: boolean) => {
      const textSnapshot = streamedText;
      const reasoningSnapshot = streamedReasoningText;
      if (!assistantInserted && !textSnapshot && !reasoningSnapshot && !force) {
        return;
      }

      const updatedAt = isoNow();
      const tokenCount = finalOutputTokens ?? estimateTokenCount(textSnapshot);

      if (!assistantInserted) {
        assistantInserted = true;
        await this.db.execute(
          `
            INSERT INTO ${APP_TABLES.messages}
              (id, conversation_id, role, content_json, source, model_identifier, token_count, lmstudio_response_id, error_text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            assistantMessageId,
            conversation.id,
            MESSAGE_ROLE.assistant,
            serializeMessageContent({
              text: textSnapshot,
              reasoningText: reasoningSnapshot
            }),
            MESSAGE_SOURCE.lmStudio,
            modelIdentifier,
            tokenCount,
            null,
            null,
            assistantCreatedAt,
            updatedAt
          ]
        );
        return;
      }

      await this.db.execute(
        `
          UPDATE ${APP_TABLES.messages}
          SET content_json = ?, token_count = ?, updated_at = ?
          WHERE id = ?
        `,
        [
          serializeMessageContent({
            text: textSnapshot,
            reasoningText: reasoningSnapshot
          }),
          tokenCount,
          updatedAt,
          assistantMessageId
        ]
      );
    };

    const queueFlush = (force: boolean) => {
      flushChain = flushChain.then(() => flushAssistantMessage(force));
      return flushChain;
    };

    const scheduleFlush = () => {
      if (flushTimer) {
        return;
      }

      flushTimer = setTimeout(() => {
        flushTimer = null;
        void queueFlush(false);
      }, 100);
    };

    let lmResult;
    try {
      lmResult = await runChat({
        model: modelIdentifier,
        input: parseMessageContent(userMessage.content_json).text,
        previousResponseId: thread?.current_response_id,
        reasoning: payload.reasoning,
        onReasoningDelta: (delta) => {
          streamedReasoningText += delta;
          scheduleFlush();
        },
        onMessageDelta: (delta) => {
          streamedText += delta;
          scheduleFlush();
        }
      });
    } catch (error) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await queueFlush(true);

      if (assistantInserted) {
        await this.db.execute(
          `
            UPDATE ${APP_TABLES.messages}
            SET error_text = ?, updated_at = ?
            WHERE id = ?
          `,
          [
            error instanceof Error ? error.message : "LM Studio streaming failed",
            isoNow(),
            assistantMessageId
          ]
        );
      }

      throw error;
    }

    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    streamedText = lmResult.text;
    streamedReasoningText = lmResult.reasoningText;
    finalOutputTokens = lmResult.outputTokens;
    await queueFlush(true);

    const allMessages = await this.db.getAll<MessageRow>(
      `
        SELECT *
        FROM ${APP_TABLES.messages}
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `,
      [conversation.id]
    );
    const normalizedMessages = allMessages.map((message) => ({
      id: message.id,
      role: message.role ?? MESSAGE_ROLE.user,
      content_json: message.content_json ?? serializeMessageContent(""),
      model_identifier: message.model_identifier ?? null,
      token_count: message.token_count ?? 0,
      created_at: message.created_at ?? assistantCreatedAt
    }));

    if (payload.materialize_sidebar !== false) {
      await materializeConversationFile({
        cacheDir: bridgeConfig.lmStudioConversationsDir,
        cacheFilename,
        title: nextTitle,
        createdAt: conversation.created_at ?? assistantCreatedAt,
        modelIdentifier,
        messages: normalizedMessages
      });
    }

    const completedAt = isoNow();

    await this.db.writeTransaction(async (tx) => {
      await tx.execute(
        `
          UPDATE ${APP_TABLES.messages}
          SET content_json = ?, token_count = ?, lmstudio_response_id = ?, error_text = null, updated_at = ?
          WHERE id = ?
        `,
        [
          serializeMessageContent({
            text: lmResult.text,
            reasoningText: lmResult.reasoningText
          }),
          lmResult.outputTokens,
          lmResult.responseId,
          completedAt,
          assistantMessageId
        ]
      );

      if (thread) {
        await tx.execute(
          `
            UPDATE ${APP_TABLES.lmstudioThreads}
            SET current_response_id = ?, model_identifier = ?, cache_filename = ?, last_synced_at = ?, updated_at = ?
            WHERE id = ?
          `,
          [
            lmResult.responseId,
            modelIdentifier,
            cacheFilename,
            completedAt,
            completedAt,
            thread.id
          ]
        );
      } else {
        await tx.execute(
          `
            INSERT INTO ${APP_TABLES.lmstudioThreads}
              (id, conversation_id, device_id, current_response_id, model_identifier, cache_filename, last_synced_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            randomUUID(),
            conversation.id,
            this.deviceId,
            lmResult.responseId,
            modelIdentifier,
            cacheFilename,
            completedAt,
            completedAt,
            completedAt
          ]
        );
      }

      await tx.execute(
        `
          UPDATE ${APP_TABLES.conversations}
          SET title = ?, updated_at = ?, last_message_at = ?
          WHERE id = ?
        `,
        [nextTitle, completedAt, completedAt, conversation.id]
      );

      await tx.execute(
        `
          UPDATE ${APP_TABLES.deviceOperations}
          SET status = ?, error_text = null, completed_at = ?, updated_at = ?
          WHERE id = ?
        `,
        [DEVICE_OPERATION_STATUS.completed, completedAt, completedAt, operation.id]
      );

      await tx.execute(
        `
          INSERT INTO ${APP_TABLES.operationEvents}
            (id, operation_id, device_id, event_type, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          operation.id,
          this.deviceId,
          OPERATION_EVENT_TYPE.benchmarkBridgeResponseWritten,
          JSON.stringify({
            assistant_message_id: assistantMessageId,
            response_id: lmResult.responseId,
            model_identifier: modelIdentifier
          }),
          completedAt
        ]
      );

      await tx.execute(
        `
          INSERT INTO ${APP_TABLES.operationEvents}
            (id, operation_id, device_id, event_type, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          operation.id,
          this.deviceId,
          OPERATION_EVENT_TYPE.completed,
          JSON.stringify({
            assistant_message_id: assistantMessageId,
            response_id: lmResult.responseId,
            model_identifier: modelIdentifier
          }),
          completedAt
        ]
      );
    });
  }

  private async markOperationRunning(operationId: string) {
    const now = isoNow();
    await this.db.writeTransaction(async (tx) => {
      await tx.execute(
        `
          UPDATE ${APP_TABLES.deviceOperations}
          SET status = ?, claimed_at = ?, updated_at = ?, error_text = null
          WHERE id = ?
        `,
        [DEVICE_OPERATION_STATUS.running, now, now, operationId]
      );

      await tx.execute(
        `
          INSERT INTO ${APP_TABLES.operationEvents}
            (id, operation_id, device_id, event_type, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [randomUUID(), operationId, this.deviceId, OPERATION_EVENT_TYPE.running, JSON.stringify({}), now]
      );
    });
  }

  private async markOperationCompleted(operationId: string, payload: Record<string, unknown>) {
    const now = isoNow();
    await this.db.writeTransaction(async (tx) => {
      await tx.execute(
        `
          UPDATE ${APP_TABLES.deviceOperations}
          SET status = ?, error_text = null, completed_at = ?, updated_at = ?
          WHERE id = ?
        `,
        [DEVICE_OPERATION_STATUS.completed, now, now, operationId]
      );

      await tx.execute(
        `
          INSERT INTO ${APP_TABLES.operationEvents}
            (id, operation_id, device_id, event_type, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          operationId,
          this.deviceId,
          OPERATION_EVENT_TYPE.completed,
          JSON.stringify(payload),
          now
        ]
      );
    });
  }

  private async markOperationFailed(operationId: string, errorText: string) {
    const now = isoNow();
    await this.db.writeTransaction(async (tx) => {
      await tx.execute(
        `
          UPDATE ${APP_TABLES.deviceOperations}
          SET status = ?, error_text = ?, completed_at = ?, updated_at = ?
          WHERE id = ?
        `,
        [DEVICE_OPERATION_STATUS.failed, errorText, now, now, operationId]
      );

      await tx.execute(
        `
          INSERT INTO ${APP_TABLES.operationEvents}
            (id, operation_id, device_id, event_type, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          randomUUID(),
          operationId,
          this.deviceId,
          OPERATION_EVENT_TYPE.failed,
          JSON.stringify({ error: errorText }),
          now
        ]
      );
    });
  }

  private async requireConversation(conversationId: string | null): Promise<ConversationRow> {
    if (!conversationId) {
      throw new Error("Missing conversation_id on device operation");
    }

    const conversation = await this.db.getOptional<ConversationRow>(
      `SELECT * FROM ${APP_TABLES.conversations} WHERE id = ?`,
      [conversationId]
    );

    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    return conversation;
  }

  private async requireMessage(messageId: string): Promise<MessageRow | null> {
    return this.db.getOptional<MessageRow>(
      `SELECT * FROM ${APP_TABLES.messages} WHERE id = ?`,
      [messageId]
    );
  }

  private async getLatestUserMessage(conversationId: string) {
    return this.db.getOptional<MessageRow>(
      `
        SELECT *
        FROM ${APP_TABLES.messages}
        WHERE conversation_id = ?
          AND role = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
      [conversationId, MESSAGE_ROLE.user]
    );
  }

  private async getPreferredModelIdentifier(): Promise<string | null> {
    if (!this.deviceId) {
      return null;
    }

    const model = await this.db.getOptional<{ model_identifier: string }>(
      `
        SELECT model_identifier
        FROM ${APP_TABLES.deviceModels}
        WHERE device_id = ?
        ORDER BY
          CASE
            WHEN lower(model_identifier) LIKE '%embed%' OR lower(model_identifier) LIKE '%embedding%' THEN 1
            ELSE 0
          END ASC,
          is_loaded DESC,
          updated_at DESC
        LIMIT 1
      `,
      [this.deviceId]
    );

    return model?.model_identifier ?? null;
  }

  private async importConversationFile(
    thread: LmThreadRow,
    imported: ImportedConversationFile | null,
    mtimeMs: number
  ) {
    if (!imported) {
      return;
    }

    const conversation = await this.requireConversation(thread.conversation_id);
    const canonicalMessages = await this.db.getAll<MessageRow>(
      `
        SELECT *
        FROM ${APP_TABLES.messages}
        WHERE conversation_id = ?
        ORDER BY created_at ASC, id ASC
      `,
      [conversation.id]
    );

    const comparableCanonical = canonicalMessages
      .filter((message) => message.role === MESSAGE_ROLE.user || message.role === MESSAGE_ROLE.assistant)
      .map((message) =>
        this.toComparableMessage(
          message.role ?? MESSAGE_ROLE.user,
          parseMessageContent(message.content_json).text
        )
      );
    const comparableImported = imported.messages.map((message) =>
      this.toComparableMessage(message.role, message.text)
    );

    if (!this.isOrderedPrefix(comparableCanonical, comparableImported)) {
      console.warn("[bridge] Skipping LM Studio conversation import because messages diverged", {
        conversationId: conversation.id,
        cacheFilename: thread.cache_filename,
        canonicalCount: comparableCanonical.length,
        importedCount: comparableImported.length
      });
      return;
    }

    const tail = imported.messages.slice(comparableCanonical.length);
    const syncTimestamp = new Date(mtimeMs).toISOString();
    const importedLastMessageAt =
      imported.lastActivityAtMs != null ? new Date(imported.lastActivityAtMs).toISOString() : null;

    if (tail.length === 0) {
      await this.db.writeTransaction(async (tx) => {
        await tx.execute(
          `
            UPDATE ${APP_TABLES.lmstudioThreads}
            SET model_identifier = ?, last_synced_at = ?, updated_at = ?
            WHERE id = ?
          `,
          [imported.modelIdentifier ?? thread.model_identifier, syncTimestamp, syncTimestamp, thread.id]
        );

        if (
          imported.title !== conversation.title ||
          (importedLastMessageAt != null &&
            (conversation.last_message_at ?? null) !== importedLastMessageAt)
        ) {
          await tx.execute(
            `
              UPDATE ${APP_TABLES.conversations}
              SET title = ?, updated_at = ?, last_message_at = ?
              WHERE id = ?
            `,
            [
              imported.title,
              syncTimestamp,
              importedLastMessageAt ?? conversation.last_message_at,
              conversation.id
            ]
          );
        }
      });
      return;
    }

    const appendedMessages = this.buildImportedMessages({
      tail,
      baselineMessages: canonicalMessages,
      fallbackModelIdentifier: imported.modelIdentifier ?? thread.model_identifier,
      importedAtMs: mtimeMs,
      conversationId: conversation.id
    });
    const lastAppendedMessage = appendedMessages[appendedMessages.length - 1];
    const nextTitle = imported.title || conversation.title || DEFAULT_CONVERSATION_TITLE;
    const nextLastMessageAt = importedLastMessageAt ?? lastAppendedMessage.created_at;

    await this.db.writeTransaction(async (tx) => {
      for (const message of appendedMessages) {
        await tx.execute(
          `
            INSERT INTO ${APP_TABLES.messages}
              (id, conversation_id, role, content_json, source, model_identifier, token_count, lmstudio_response_id, error_text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            message.id,
            message.conversation_id,
            message.role,
            message.content_json,
            message.source,
            message.model_identifier,
            message.token_count,
            null,
            null,
            message.created_at,
            message.updated_at
          ]
        );
      }

      await tx.execute(
        `
          UPDATE ${APP_TABLES.lmstudioThreads}
          SET model_identifier = ?, last_synced_at = ?, updated_at = ?
          WHERE id = ?
        `,
        [
          imported.modelIdentifier ?? thread.model_identifier,
          syncTimestamp,
          syncTimestamp,
          thread.id
        ]
      );

      await tx.execute(
        `
          UPDATE ${APP_TABLES.conversations}
          SET title = ?, updated_at = ?, last_message_at = ?
          WHERE id = ?
        `,
        [nextTitle, syncTimestamp, nextLastMessageAt, conversation.id]
      );
    });

    console.log("[bridge] Imported LM Studio messages into canonical conversation", {
      conversationId: conversation.id,
      cacheFilename: thread.cache_filename,
      importedCount: appendedMessages.length
    });
  }

  private buildImportedMessages(params: {
    tail: ImportedConversationFileMessage[];
    baselineMessages: MessageRow[];
    fallbackModelIdentifier: string | null;
    importedAtMs: number;
    conversationId: string;
  }) {
    let cursorMs = this.getBaselineTimestamp(params.baselineMessages, params.importedAtMs);

    return params.tail.map((message) => {
      const nextTimestampMs =
        message.timestampMs != null
          ? Math.max(cursorMs + 1, message.timestampMs)
          : cursorMs + 1;
      cursorMs = nextTimestampMs;

      return {
        id: randomUUID(),
        conversation_id: params.conversationId,
        role: message.role,
        content_json: serializeMessageContent(message.text),
        source: MESSAGE_SOURCE.lmStudio,
        model_identifier:
          message.role === MESSAGE_ROLE.assistant
            ? message.modelIdentifier ?? params.fallbackModelIdentifier
            : null,
        token_count: message.tokenCount ?? 0,
        created_at: new Date(nextTimestampMs).toISOString(),
        updated_at: new Date(nextTimestampMs).toISOString()
      };
    });
  }

  private getBaselineTimestamp(messages: MessageRow[], fallbackMs: number) {
    let baseline = Math.max(0, fallbackMs - 1000);

    for (const message of messages) {
      if (!message.created_at) {
        continue;
      }

      const parsed = Date.parse(message.created_at);
      if (!Number.isNaN(parsed)) {
        baseline = Math.max(baseline, parsed);
      }
    }

    return baseline;
  }

  private isOrderedPrefix(canonical: ComparableMessage[], imported: ComparableMessage[]) {
    if (canonical.length > imported.length) {
      return false;
    }

    for (let index = 0; index < canonical.length; index += 1) {
      if (!this.isSameComparableMessage(canonical[index], imported[index])) {
        return false;
      }
    }

    return true;
  }

  private isSameComparableMessage(left: ComparableMessage, right: ComparableMessage) {
    return left.role === right.role && left.text === right.text;
  }

  private toComparableMessage(role: string, text: string): ComparableMessage {
    return {
      role,
      text: text.replace(/\r\n/g, "\n").trim()
    };
  }

  private maybeAnnouncePairing(deviceId: string, pairingStatus: string | null, pairingCode: string | null) {
    if (pairingStatus === DEVICE_PAIRING_STATUS.paired) {
      this.announcedPairingStateKey = null;
      return;
    }

    const announcementKey = `${deviceId}:${pairingStatus ?? ""}:${pairingCode ?? ""}`;
    if (this.announcedPairingStateKey === announcementKey) {
      return;
    }

    this.announcedPairingStateKey = announcementKey;
    console.log("[bridge] Device is pending pairing approval", {
      deviceId,
      pairingCode,
      machineKey: bridgeConfig.bridgeMachineKey
    });
  }

}
