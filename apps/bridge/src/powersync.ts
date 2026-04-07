import path from "node:path";
import { promises as fs } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { FetchStrategy, PowerSyncDatabase, SyncStatus, UpdateType } from "@powersync/node";
import type {
  AbstractPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  PowerSyncCredentials
} from "@powersync/node";
import {
  APP_TABLES,
  AppSchema,
  BOOLEAN_COLUMNS
} from "@synced-lm-studio/shared";
import { ensureBridgeSession } from "./auth";
import { bridgeConfig } from "./config";

function normalizeRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const booleanColumns = new Set(BOOLEAN_COLUMNS[table] ?? []);
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (booleanColumns.has(key) && typeof value === "number") {
        return [key, value === 1];
      }

      return [key, value];
    })
  );
}

async function recordUploadError(
  database: AbstractPowerSyncDatabase,
  scope: string,
  entry: CrudEntry,
  message: string,
  details: string
) {
  await database.execute(
    `
      INSERT INTO ${APP_TABLES.localUploadErrors}
        (id, scope, table_name, record_id, message, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      crypto.randomUUID(),
      scope,
      entry.table,
      entry.id,
      message,
      details,
      new Date().toISOString()
    ]
  );
}

function decodeJwtPart(raw: string): Record<string, unknown> | null {
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const decoded = Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function summarizeJwt(token: string) {
  const [headerRaw, payloadRaw] = token.split(".");
  const header = headerRaw ? decodeJwtPart(headerRaw) : null;
  const payload = payloadRaw ? decodeJwtPart(payloadRaw) : null;

  return {
    header,
    payload: payload
      ? {
          iss: payload.iss ?? null,
          aud: payload.aud ?? null,
          sub: payload.sub ?? null,
          role: payload.role ?? null
        }
      : null
  };
}

type LoggedSyncStatus = {
  connected: boolean;
  connecting: boolean;
  hasSynced: boolean | null;
  downloading: boolean;
  uploading: boolean;
  downloadError: string | null;
  uploadError: string | null;
  lastSyncedAt: string | null;
  progressBucket: number | null;
  progressLabel: string | null;
};

function toLoggedSyncStatus(status: SyncStatus): LoggedSyncStatus {
  const dataFlow = status.dataFlowStatus;
  const progress = status.downloadProgress;
  const percent =
    progress && progress.totalOperations > 0
      ? Math.floor(progress.downloadedFraction * 100)
      : null;

  return {
    connected: status.connected,
    connecting: status.connecting,
    hasSynced: status.hasSynced ?? null,
    downloading: dataFlow.downloading ?? false,
    uploading: dataFlow.uploading ?? false,
    downloadError: dataFlow.downloadError?.message ?? null,
    uploadError: dataFlow.uploadError?.message ?? null,
    lastSyncedAt: status.lastSyncedAt?.toISOString() ?? null,
    progressBucket: percent === null ? null : Math.min(100, Math.floor(percent / 10) * 10),
    progressLabel:
      progress && percent !== null
        ? `${progress.downloadedOperations}/${progress.totalOperations} (${percent}%)`
        : null
  };
}

function formatLoggedSyncStatus(status: LoggedSyncStatus) {
  const parts: string[] = [];

  if (status.connecting) {
    parts.push("connecting");
  } else {
    parts.push(status.connected ? "connected" : "disconnected");
  }

  const activity: string[] = [];
  if (status.downloading) {
    activity.push(
      status.progressLabel ? `downloading ${status.progressLabel}` : "downloading"
    );
  }
  if (status.uploading) {
    activity.push("uploading");
  }
  parts.push(activity.length > 0 ? activity.join(", ") : "idle");

  if (status.hasSynced === true) {
    parts.push(status.lastSyncedAt ? `synced ${status.lastSyncedAt}` : "synced");
  } else if (status.hasSynced === false) {
    parts.push("sync pending");
  }

  if (status.downloadError) {
    parts.push(`download error: ${status.downloadError}`);
  }
  if (status.uploadError) {
    parts.push(`upload error: ${status.uploadError}`);
  }

  return parts.join(" | ");
}

class PowerSyncStatusLogger {
  private previous: LoggedSyncStatus | null = null;

  log(status: SyncStatus) {
    const next = toLoggedSyncStatus(status);
    if (!this.shouldLog(next)) {
      return;
    }

    console.log("[bridge] PowerSync", formatLoggedSyncStatus(next));
    this.previous = next;
  }

  private shouldLog(next: LoggedSyncStatus) {
    const previous = this.previous;
    if (!previous) {
      return true;
    }

    return (
      previous.connected !== next.connected ||
      previous.connecting !== next.connecting ||
      previous.hasSynced !== next.hasSynced ||
      previous.downloading !== next.downloading ||
      previous.downloadError !== next.downloadError ||
      previous.uploadError !== next.uploadError ||
      (next.downloading && previous.progressBucket !== next.progressBucket)
    );
  }
}

async function upsertRow(supabase: SupabaseClient, table: string, row: Record<string, unknown>) {
  return supabase.from(table).upsert(row, { onConflict: "id" });
}

async function patchRow(
  supabase: SupabaseClient,
  table: string,
  id: string,
  row: Record<string, unknown>
) {
  return supabase.from(table).update(row).eq("id", id);
}

async function deleteRow(supabase: SupabaseClient, table: string, id: string) {
  return supabase.from(table).delete().eq("id", id);
}

class BridgeConnector implements PowerSyncBackendConnector {
  constructor(private readonly supabase: SupabaseClient) {}

  async fetchCredentials(): Promise<PowerSyncCredentials> {
    const session = await ensureBridgeSession(this.supabase);
    console.log("[bridge] PowerSync credentials prepared", summarizeJwt(session.access_token));
    if (bridgeConfig.logFullJwt) {
      console.log("[bridge] PowerSync raw JWT", session.access_token);
    }
    return {
      endpoint: bridgeConfig.powersyncUrl,
      token: session.access_token,
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : undefined
    };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) {
      return;
    }

    for (const entry of transaction.crud) {
      const row = normalizeRow(entry.table, {
        id: entry.id,
        ...(entry.opData ?? {})
      });

      if (entry.op === UpdateType.PUT) {
        const { error } = await upsertRow(this.supabase, entry.table, row);
        if (error) {
          await recordUploadError(database, "bridge", entry, error.message, JSON.stringify(error));
        }
        continue;
      }

      if (entry.op === UpdateType.PATCH) {
        const { error } = await patchRow(
          this.supabase,
          entry.table,
          entry.id,
          normalizeRow(entry.table, entry.opData ?? {})
        );
        if (error) {
          await recordUploadError(database, "bridge", entry, error.message, JSON.stringify(error));
        }
        continue;
      }

      if (entry.op === UpdateType.DELETE) {
        const { error } = await deleteRow(this.supabase, entry.table, entry.id);
        if (error) {
          await recordUploadError(database, "bridge", entry, error.message, JSON.stringify(error));
        }
      }
    }

    await transaction.complete();
  }
}

export async function createBridgeDatabase() {
  await fs.mkdir(path.dirname(bridgeConfig.bridgeDbFilename), { recursive: true });
  console.log("[bridge] Using bridge profile", {
    envPath: bridgeConfig.envPath,
    envProfile: bridgeConfig.envProfile,
    machineKey: bridgeConfig.bridgeMachineKey,
    dbFilename: bridgeConfig.bridgeDbFilename,
    sessionFilename: bridgeConfig.bridgeSessionFilename,
    powersyncUrl: bridgeConfig.powersyncUrl,
    supabaseUrl: bridgeConfig.supabaseUrl,
    lmStudioConversationsDir: bridgeConfig.lmStudioConversationsDir
  });

  const supabase = createClient(bridgeConfig.supabaseUrl, bridgeConfig.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: true
    }
  });

  const session = await ensureBridgeSession(supabase);
  console.log("[bridge] Supabase session ready", { userId: session.user.id });

  const db = new PowerSyncDatabase({
    schema: AppSchema,
    database: {
      dbFilename: bridgeConfig.bridgeDbFilename
    }
  });
  const statusLogger = new PowerSyncStatusLogger();

  db.registerListener({
    statusChanged: (status) => {
      statusLogger.log(status);
    }
  });

  console.log("[bridge] Waiting for local PowerSync database readiness");
  await db.waitForReady();
  console.log("[bridge] Local PowerSync database ready");

  const connector = new BridgeConnector(supabase);
  console.log("[bridge] Connecting to PowerSync");
  await db.connect(connector, {
    fetchStrategy: FetchStrategy.Sequential
  });
  console.log("[bridge] Waiting for first PowerSync sync");
  await db.waitForFirstSync();
  console.log("[bridge] First PowerSync sync complete");

  return { db, supabase, ownerUserId: session.user.id };
}
