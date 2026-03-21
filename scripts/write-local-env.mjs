import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseEnvOutput(raw) {
  const values = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length)
      : trimmed;
    const separator = normalized.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function requireValue(values, key) {
  const value = values[key];
  if (!value) {
    throw new Error(`Missing ${key} in supabase status output`);
  }

  return value;
}

async function main() {
  const { stdout } = await execFileAsync("supabase", ["status", "-o", "env"], {
    cwd: process.cwd()
  });
  const values = parseEnvOutput(stdout);
  const supabaseUrl = requireValue(values, "API_URL");
  const anonKey = requireValue(values, "ANON_KEY");
  const serviceRoleKey = values.SERVICE_ROLE_KEY ?? "";

  const devEmail = process.env.DEV_EMAIL ?? "dev@synced-lm-studio.local";
  const devPassword = process.env.DEV_PASSWORD ?? "dev-password-1234";
  const lmStudioDir =
    process.env.LM_STUDIO_CONVERSATIONS_DIR ??
    path.join(os.homedir(), ".cache", "lm-studio", "conversations");

  const webEnv = [
    `VITE_SUPABASE_URL=${supabaseUrl}`,
    `VITE_SUPABASE_ANON_KEY=${anonKey}`,
    "VITE_POWERSYNC_URL=http://127.0.0.1:8080",
    `VITE_DEV_EMAIL=${devEmail}`,
    `VITE_DEV_PASSWORD=${devPassword}`
  ].join("\n");

  const bridgeEnv = [
    `SUPABASE_URL=${supabaseUrl}`,
    `SUPABASE_ANON_KEY=${anonKey}`,
    "POWERSYNC_URL=http://127.0.0.1:8080",
    `SUPABASE_EMAIL=${devEmail}`,
    `SUPABASE_PASSWORD=${devPassword}`,
    "LM_STUDIO_BASE_URL=http://127.0.0.1:1234",
    `LM_STUDIO_CONVERSATIONS_DIR=${lmStudioDir}`,
    "BRIDGE_DEVICE_NAME=Local LM Studio",
    "BRIDGE_MACHINE_KEY=lmstudio-local",
    "BRIDGE_DB_FILENAME=.data/bridge.db"
  ].join("\n");

  await fs.mkdir(path.join(process.cwd(), "apps", "web"), { recursive: true });
  await fs.mkdir(path.join(process.cwd(), "apps", "bridge"), { recursive: true });

  await Promise.all([
    fs.writeFile(path.join("apps", "web", ".env.local"), `${webEnv}\n`, "utf8"),
    fs.writeFile(path.join("apps", "bridge", ".env.local"), `${bridgeEnv}\n`, "utf8")
  ]);

  if (serviceRoleKey) {
    console.log("Wrote apps/web/.env.local and apps/bridge/.env.local");
    console.log("SERVICE_ROLE_KEY is available for bootstrap:dev-user");
    return;
  }

  console.log("Wrote apps/web/.env.local and apps/bridge/.env.local");
  console.log("SERVICE_ROLE_KEY was not present in supabase status output.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
