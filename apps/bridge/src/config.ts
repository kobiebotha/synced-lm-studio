import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(moduleDir, "..");

dotenv.config({ path: path.join(appRoot, ".env.local") });
dotenv.config({ path: path.join(appRoot, ".env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function numeric(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number for ${name}: ${value}`);
  }

  return parsed;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean for ${name}: ${value}`);
}

function toFilenameSlug(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

function storageSlug() {
  const source = process.env.POWERSYNC_URL ?? process.env.SUPABASE_URL ?? "bridge";
  try {
    const url = new URL(source);
    const hostSlug = toFilenameSlug(url.host);
    return hostSlug || "bridge";
  } catch {
    return toFilenameSlug(source) || "bridge";
  }
}

const bridgeStorageSlug = storageSlug();

export const bridgeConfig = {
  supabaseUrl: required("SUPABASE_URL"),
  supabaseAnonKey: required("SUPABASE_ANON_KEY"),
  supabaseEmail: process.env.SUPABASE_EMAIL ?? "",
  supabasePassword: process.env.SUPABASE_PASSWORD ?? "",
  powersyncUrl: required("POWERSYNC_URL"),
  lmStudioBaseUrl: process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234",
  lmStudioConversationsDir:
    process.env.LM_STUDIO_CONVERSATIONS_DIR ??
    path.join(os.homedir(), ".cache", "lm-studio", "conversations"),
  bridgeDeviceName: process.env.BRIDGE_DEVICE_NAME ?? "Local LM Studio",
  bridgeMachineKey: process.env.BRIDGE_MACHINE_KEY ?? `lmstudio-${os.hostname()}`,
  bridgeDbFilename:
    process.env.BRIDGE_DB_FILENAME ?? `.data/bridge-${bridgeStorageSlug}.db`,
  bridgeSessionFilename:
    process.env.BRIDGE_SESSION_FILENAME ??
    `.data/bridge-session-${bridgeStorageSlug}.json`,
  logFullJwt: boolean("BRIDGE_LOG_FULL_JWT", false),
  pollIntervalMs: numeric("BRIDGE_POLL_INTERVAL_MS", 2000),
  heartbeatIntervalMs: numeric("BRIDGE_HEARTBEAT_INTERVAL_MS", 30000),
  modelsRefreshIntervalMs: numeric("BRIDGE_MODELS_REFRESH_INTERVAL_MS", 30000),
  bridgeVersion: process.env.npm_package_version ?? "0.1.0"
};
