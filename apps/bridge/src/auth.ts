import { promises as fs } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { bridgeConfig } from "./config";

type StoredBridgeSession = Pick<
  Session,
  "access_token" | "refresh_token" | "expires_at" | "expires_in" | "token_type" | "user"
>;

function extractPersistedSession(session: Session): StoredBridgeSession {
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    token_type: session.token_type,
    user: session.user
  };
}

async function loadStoredSession(): Promise<StoredBridgeSession | null> {
  try {
    const raw = await fs.readFile(bridgeConfig.bridgeSessionFilename, "utf8");
    return JSON.parse(raw) as StoredBridgeSession;
  } catch (error) {
    const isMissing =
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT";

    if (isMissing) {
      return null;
    }

    throw error;
  }
}

async function persistSession(session: Session | null) {
  if (!session) {
    try {
      await fs.unlink(bridgeConfig.bridgeSessionFilename);
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
    return;
  }

  await fs.writeFile(
    bridgeConfig.bridgeSessionFilename,
    `${JSON.stringify(extractPersistedSession(session), null, 2)}\n`,
    "utf8"
  );
}

async function signInWithPassword(
  supabase: SupabaseClient,
  email: string,
  password: string
): Promise<Session> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw error ?? new Error("Failed to sign in to Supabase");
  }

  return data.session;
}

async function tryRestoreStoredSession(supabase: SupabaseClient): Promise<Session | null> {
  const stored = await loadStoredSession();
  if (!stored?.access_token || !stored.refresh_token) {
    return null;
  }

  const { data, error } = await supabase.auth.setSession({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token
  });

  if (error || !data.session) {
    await persistSession(null);
    return null;
  }

  return data.session;
}

async function prompt(question: string) {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    return (await readline.question(question)).trim();
  } finally {
    readline.close();
  }
}

async function promptSecret(question: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return prompt(question);
  }

  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;
    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.isTTY) {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdout.write("\n");
    };

    const onData = (chunk: string | Buffer) => {
      const text = chunk.toString("utf8");

      if (text === "\u0003") {
        cleanup();
        reject(new Error("Bridge sign-in cancelled"));
        return;
      }

      if (text === "\r" || text === "\n") {
        cleanup();
        resolve(value.trim());
        return;
      }

      if (text === "\u0008" || text === "\u007f") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write("\b \b");
        }
        return;
      }

      value += text;
      stdout.write("*");
    };

    stdout.write(question);
    stdin.resume();
    stdin.setEncoding("utf8");
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.on("data", onData);
  });
}

async function signInInteractively(supabase: SupabaseClient): Promise<Session> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "No stored bridge session and no configured Supabase credentials. Run the bridge in a TTY or set SUPABASE_EMAIL/SUPABASE_PASSWORD."
    );
  }

  console.log("[bridge] No stored Supabase session found. Sign in to pair this bridge.");
  const email = await prompt("Supabase email: ");
  const password = await promptSecret("Supabase password: ");

  if (!email || !password) {
    throw new Error("Email and password are required to sign in the bridge");
  }

  return signInWithPassword(supabase, email, password);
}

export async function ensureBridgeSession(supabase: SupabaseClient): Promise<Session> {
  supabase.auth.onAuthStateChange((_event, session) => {
    void persistSession(session);
  });

  const { data } = await supabase.auth.getSession();
  if (data.session) {
    return data.session;
  }

  const restored = await tryRestoreStoredSession(supabase);
  if (restored) {
    console.log("[bridge] Restored Supabase session from local session file");
    return restored;
  }

  if (bridgeConfig.supabaseEmail && bridgeConfig.supabasePassword) {
    console.log("[bridge] Signing in with configured Supabase bridge credentials");
    return signInWithPassword(
      supabase,
      bridgeConfig.supabaseEmail,
      bridgeConfig.supabasePassword
    );
  }

  return signInInteractively(supabase);
}
