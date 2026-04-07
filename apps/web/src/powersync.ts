import {
  APP_TABLES,
  AppSchema,
  BOOLEAN_COLUMNS
} from "@synced-lm-studio/shared";
import { PowerSyncDatabase, UpdateType, WASQLiteOpenFactory, WASQLiteVFS } from "@powersync/web";
import type {
  AbstractPowerSyncDatabase,
  CrudEntry,
  PowerSyncBackendConnector,
  PowerSyncCredentials
} from "@powersync/web";
import type { SupabaseClient } from "@supabase/supabase-js";

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
    [crypto.randomUUID(), "web", entry.table, entry.id, message, details, new Date().toISOString()]
  );
}

async function ensureSession(supabase: SupabaseClient) {
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    return data.session;
  }

  throw new Error("No active Supabase session");
}

class WebConnector implements PowerSyncBackendConnector {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly powersyncUrl: string
  ) {}

  async fetchCredentials(): Promise<PowerSyncCredentials> {
    const session = await ensureSession(this.supabase);
    return {
      endpoint: this.powersyncUrl,
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
      if (entry.op === UpdateType.PUT) {
        const { error } = await this.supabase
          .from(entry.table)
          .upsert(normalizeRow(entry.table, { id: entry.id, ...(entry.opData ?? {}) }), {
            onConflict: "id"
          });
        if (error) {
          await recordUploadError(database, entry, error.message, JSON.stringify(error));
        }
        continue;
      }

      if (entry.op === UpdateType.PATCH) {
        const { error } = await this.supabase
          .from(entry.table)
          .update(normalizeRow(entry.table, entry.opData ?? {}))
          .eq("id", entry.id);
        if (error) {
          await recordUploadError(database, entry, error.message, JSON.stringify(error));
        }
        continue;
      }

      if (entry.op === UpdateType.DELETE) {
        const { error } = await this.supabase.from(entry.table).delete().eq("id", entry.id);
        if (error) {
          await recordUploadError(database, entry, error.message, JSON.stringify(error));
        }
      }
    }

    await transaction.complete();
  }
}

export async function createWebDatabase(supabase: SupabaseClient, powersyncUrl: string) {
  const database = new PowerSyncDatabase({
    schema: AppSchema,
    database: new WASQLiteOpenFactory({
      dbFilename: "synced-lm-studio.db",
      vfs: WASQLiteVFS.OPFSCoopSyncVFS
    })
  });

  await database.connect(new WebConnector(supabase, powersyncUrl));

  return database;
}
