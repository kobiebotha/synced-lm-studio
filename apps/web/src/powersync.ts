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
  PowerSyncCredentials,
  WebPowerSyncFlags
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

type CreateWebDatabaseOptions = {
  allowAnonymous?: boolean;
  dbFilename?: string;
  flags?: WebPowerSyncFlags;
  readOnly?: boolean;
};

async function ensureSession(supabase: SupabaseClient, allowAnonymous = false) {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    throw error;
  }

  if (data.session) {
    return data.session;
  }

  if (allowAnonymous) {
    const { data: anonymousData, error: anonymousError } = await supabase.auth.signInAnonymously();
    if (anonymousError) {
      throw anonymousError;
    }

    if (anonymousData.session) {
      return anonymousData.session;
    }
  }

  throw new Error("No active Supabase session");
}

class WebConnector implements PowerSyncBackendConnector {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly powersyncUrl: string,
    private readonly options: {
      allowAnonymous?: boolean;
      readOnly?: boolean;
    } = {}
  ) {}

  async fetchCredentials(): Promise<PowerSyncCredentials> {
    const session = await ensureSession(this.supabase, this.options.allowAnonymous);
    return {
      endpoint: this.powersyncUrl,
      token: session.access_token,
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : undefined
    };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    if (this.options.readOnly) {
      return;
    }

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

export async function createWebDatabase(
  supabase: SupabaseClient,
  powersyncUrl: string,
  options: CreateWebDatabaseOptions = {}
) {
  const database = new PowerSyncDatabase({
    schema: AppSchema,
    flags: options.flags,
    database: new WASQLiteOpenFactory({
      dbFilename: options.dbFilename ?? "synced-lm-studio.db",
      flags: options.flags,
      vfs: WASQLiteVFS.IDBBatchAtomicVFS
    })
  });

  await database.connect(
    new WebConnector(supabase, powersyncUrl, {
      allowAnonymous: options.allowAnonymous,
      readOnly: options.readOnly
    })
  );

  return database;
}
