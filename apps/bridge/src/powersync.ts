import path from "node:path";
import { promises as fs } from "node:fs";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { PowerSyncDatabase, UpdateType } from "@powersync/node";
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

async function ensureSession(supabase: SupabaseClient): Promise<Session> {
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    console.log("[bridge] Reusing existing Supabase session");
    return data.session;
  }

  console.log("[bridge] Signing in to Supabase");
  const { data: signedIn, error } = await supabase.auth.signInWithPassword({
    email: bridgeConfig.supabaseEmail,
    password: bridgeConfig.supabasePassword
  });

  if (error || !signedIn.session) {
    throw error ?? new Error("Failed to create Supabase session");
  }

  return signedIn.session;
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
    const session = await ensureSession(this.supabase);
    console.log("[bridge] PowerSync credentials prepared", summarizeJwt(session.access_token));
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

  const supabase = createClient(bridgeConfig.supabaseUrl, bridgeConfig.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: true
    }
  });

  const session = await ensureSession(supabase);
  console.log("[bridge] Supabase session ready", { userId: session.user.id });

  const db = new PowerSyncDatabase({
    schema: AppSchema,
    database: {
      dbFilename: bridgeConfig.bridgeDbFilename
    }
  });

  db.registerListener({
    statusChanged: (status) => {
      console.log("[bridge] PowerSync status", JSON.stringify(status));
    }
  });

  console.log("[bridge] Waiting for local PowerSync database readiness");
  await db.waitForReady();
  console.log("[bridge] Local PowerSync database ready");

  const connector = new BridgeConnector(supabase);
  console.log("[bridge] Connecting to PowerSync");
  await db.connect(connector);
  console.log("[bridge] Waiting for first PowerSync sync");
  await db.waitForFirstSync();
  console.log("[bridge] First PowerSync sync complete");

  return { db, supabase, ownerUserId: session.user.id };
}
