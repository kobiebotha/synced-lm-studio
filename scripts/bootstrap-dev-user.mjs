import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

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

async function resolveBootstrapEnv() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
    };
  }

  const { stdout } = await execFileAsync("supabase", ["status", "-o", "env"], {
    cwd: process.cwd()
  });
  const values = parseEnvOutput(stdout);

  return {
    supabaseUrl: values.API_URL ?? process.env.SUPABASE_URL,
    serviceRoleKey: values.SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  };
}

async function listUsers(url, serviceRoleKey) {
  const response = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=200`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to list users: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  return body.users ?? [];
}

async function createUser(url, serviceRoleKey, email, password) {
  const response = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to create user: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function updateUser(url, serviceRoleKey, userId, password) {
  const response = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    },
    body: JSON.stringify({
      password,
      email_confirm: true
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to update user: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function main() {
  const bootstrapEnv = await resolveBootstrapEnv();
  const supabaseUrl = bootstrapEnv.supabaseUrl ?? required("SUPABASE_URL");
  const serviceRoleKey =
    bootstrapEnv.serviceRoleKey ?? required("SUPABASE_SERVICE_ROLE_KEY");
  const email = process.env.DEV_EMAIL ?? "dev@synced-lm-studio.local";
  const password = process.env.DEV_PASSWORD ?? "dev-password-1234";

  const users = await listUsers(supabaseUrl, serviceRoleKey);
  const existing = users.find((user) => user.email?.toLowerCase() === email.toLowerCase());

  if (existing) {
    const updated = await updateUser(supabaseUrl, serviceRoleKey, existing.id, password);
    console.log(JSON.stringify({ action: "updated", email, userId: updated.id }, null, 2));
    return;
  }

  const created = await createUser(supabaseUrl, serviceRoleKey, email, password);
  console.log(JSON.stringify({ action: "created", email, userId: created.id }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
