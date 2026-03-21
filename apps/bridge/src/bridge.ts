import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PowerSyncDatabase } from "@powersync/node";
import {
  APP_TABLES,
  DEFAULT_CONVERSATION_TITLE,
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
  materialize_sidebar?: boolean;
};

type ComparableMessage = {
  role: string;
  text: string;
};

type ConversationFileState = {
  observedMtimeMs: number;
  importedMtimeMs: number;
};

function isoNow() {
  return new Date().toISOString();
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
  private lastModelsRefresh = 0;
  private timer: NodeJS.Timeout | null = null;
  private isTicking = false;
  private readonly conversationFileStates = new Map<string, ConversationFileState>();

  constructor(
    private readonly db: Database,
    private readonly ownerUserId: string
  ) {}

  async start() {
    console.log("[bridge] Starting bridge service");
    await this.ensureDeviceRow();
    console.log("[bridge] Device row ready", { deviceId: this.deviceId });
    await this.refreshModels();
    console.log("[bridge] Initial model refresh complete");
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, bridgeConfig.pollIntervalMs);
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

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

  private async tick() {
    if (this.isTicking) {
      return;
    }

    this.isTicking = true;
    try {
      await this.ensureDeviceRow();
      await this.heartbeat();
      await this.refreshModelsIfDue();
      await this.processPendingOperations();
      await this.reconcileLmStudioConversationFiles();
    } finally {
      this.isTicking = false;
    }
  }

  private async ensureDeviceRow() {
    const now = isoNow();
    const existing = await this.db.getOptional<DeviceRow>(
      `SELECT * FROM ${APP_TABLES.devices} WHERE machine_key = ?`,
      [bridgeConfig.bridgeMachineKey]
    );

    if (existing) {
      this.deviceId = existing.id;
      await this.db.execute(
        `
          UPDATE ${APP_TABLES.devices}
          SET owner_user_id = ?, display_name = ?, status = ?, platform = ?, bridge_version = ?, metadata_json = ?, last_seen_at = ?, updated_at = ?
          WHERE id = ?
        `,
        [
          this.ownerUserId,
          bridgeConfig.bridgeDeviceName,
          DEVICE_STATUS.online,
          process.platform,
          bridgeConfig.bridgeVersion,
          JSON.stringify({ hostname: process.env.HOSTNAME ?? null }),
          now,
          now,
          existing.id
        ]
      );
      return existing.id;
    }

    const deviceId = randomUUID();
    this.deviceId = deviceId;

    await this.db.execute(
      `
        INSERT INTO ${APP_TABLES.devices}
          (id, owner_user_id, machine_key, display_name, status, platform, bridge_version, metadata_json, last_seen_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        deviceId,
        this.ownerUserId,
        bridgeConfig.bridgeMachineKey,
        bridgeConfig.bridgeDeviceName,
        DEVICE_STATUS.online,
        process.platform,
        bridgeConfig.bridgeVersion,
        JSON.stringify({ hostname: process.env.HOSTNAME ?? null }),
        now,
        now,
        now
      ]
    );

    return deviceId;
  }

  private async heartbeat() {
    if (!this.deviceId) {
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
  }

  private async refreshModelsIfDue() {
    if (Date.now() - this.lastModelsRefresh < bridgeConfig.modelsRefreshIntervalMs) {
      return;
    }

    await this.refreshModels();
  }

  private async refreshModels() {
    if (!this.deviceId) {
      return;
    }

    const models = await listModels();
    const now = isoNow();

    await this.db.writeTransaction(async (tx) => {
      for (const model of models) {
        const existing = await tx.getOptional<{ id: string }>(
          `
            SELECT id
            FROM ${APP_TABLES.deviceModels}
            WHERE device_id = ? AND model_identifier = ?
          `,
          [this.deviceId, model.identifier]
        );

        if (existing) {
          await tx.execute(
            `
              UPDATE ${APP_TABLES.deviceModels}
              SET display_name = ?, is_loaded = ?, state = ?, updated_at = ?
              WHERE id = ?
            `,
            [model.displayName, model.isLoaded ? 1 : 0, model.state, now, existing.id]
          );
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
    });

    this.lastModelsRefresh = Date.now();
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

    const threads = await this.db.getAll<LmThreadRow>(
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
        importedMtimeMs: -1
      });
    } else if (existingState.observedMtimeMs !== mtimeMs) {
      existingState.observedMtimeMs = mtimeMs;
      return;
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

    const lmResult = await runChat({
      model: modelIdentifier,
      input: parseMessageContent(userMessage.content_json).text,
      previousResponseId: thread?.current_response_id
    });

    const assistantMessageId = randomUUID();
    const now = isoNow();
    const currentTitle = conversation.title ?? DEFAULT_CONVERSATION_TITLE;
    const nextTitle =
      currentTitle === DEFAULT_CONVERSATION_TITLE
        ? truncateTitle(parseMessageContent(userMessage.content_json).text)
        : currentTitle;
    const cacheFilename =
      thread?.cache_filename ??
      `${Date.parse(conversation.created_at || now) || Date.now()}.conversation.json`;

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
      created_at: message.created_at ?? now
    }));
    const nextMessages = [
      ...normalizedMessages,
      {
        id: assistantMessageId,
        role: MESSAGE_ROLE.assistant,
        content_json: serializeMessageContent(lmResult.text),
        model_identifier: modelIdentifier,
        token_count: lmResult.outputTokens,
        created_at: now
      }
    ];

    if (payload.materialize_sidebar !== false) {
      await materializeConversationFile({
        cacheDir: bridgeConfig.lmStudioConversationsDir,
        cacheFilename,
        title: nextTitle,
        createdAt: conversation.created_at ?? now,
        modelIdentifier,
        messages: nextMessages
      });
    }

    await this.db.writeTransaction(async (tx) => {
      await tx.execute(
        `
          INSERT INTO ${APP_TABLES.messages}
            (id, conversation_id, role, content_json, source, model_identifier, token_count, lmstudio_response_id, error_text, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          assistantMessageId,
          conversation.id,
          MESSAGE_ROLE.assistant,
          serializeMessageContent(lmResult.text),
          MESSAGE_SOURCE.lmStudio,
          modelIdentifier,
          lmResult.outputTokens,
          lmResult.responseId,
          null,
          now,
          now
        ]
      );

      if (thread) {
        await tx.execute(
          `
            UPDATE ${APP_TABLES.lmstudioThreads}
            SET current_response_id = ?, model_identifier = ?, cache_filename = ?, last_synced_at = ?, updated_at = ?
            WHERE id = ?
          `,
          [lmResult.responseId, modelIdentifier, cacheFilename, now, now, thread.id]
        );
      } else {
        await tx.execute(
          `
            INSERT INTO ${APP_TABLES.lmstudioThreads}
              (id, conversation_id, device_id, current_response_id, model_identifier, cache_filename, last_synced_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [randomUUID(), conversation.id, this.deviceId, lmResult.responseId, modelIdentifier, cacheFilename, now, now, now]
        );
      }

      await tx.execute(
        `
          UPDATE ${APP_TABLES.conversations}
          SET title = ?, updated_at = ?, last_message_at = ?
          WHERE id = ?
        `,
        [nextTitle, now, now, conversation.id]
      );

      await tx.execute(
        `
          UPDATE ${APP_TABLES.deviceOperations}
          SET status = ?, error_text = null, completed_at = ?, updated_at = ?
          WHERE id = ?
        `,
        [DEVICE_OPERATION_STATUS.completed, now, now, operation.id]
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
          "completed",
          JSON.stringify({
            assistant_message_id: assistantMessageId,
            response_id: lmResult.responseId,
            model_identifier: modelIdentifier
          }),
          now
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
        [randomUUID(), operationId, this.deviceId, "running", JSON.stringify({}), now]
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
        [randomUUID(), operationId, this.deviceId, "completed", JSON.stringify(payload), now]
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
          "failed",
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
        ORDER BY is_loaded DESC, updated_at DESC
        LIMIT 1
      `,
      [this.deviceId]
    );

    return model?.model_identifier ?? null;
  }

  private async importConversationFile(
    thread: LmThreadRow,
    imported: Awaited<ReturnType<typeof readConversationFile>>,
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

        if (imported.title !== conversation.title) {
          await tx.execute(
            `
              UPDATE ${APP_TABLES.conversations}
              SET title = ?, updated_at = ?
              WHERE id = ?
            `,
            [imported.title, syncTimestamp, conversation.id]
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
        [nextTitle, syncTimestamp, lastAppendedMessage.created_at, conversation.id]
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

}
