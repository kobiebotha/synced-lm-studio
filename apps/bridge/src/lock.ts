import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

type LockPayload = {
  pid: number;
  hostname: string;
  cwd: string;
  startedAt: string;
};

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

async function readExistingLock(lockFilename: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockFilename, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : -1,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "unknown-host",
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "unknown-cwd",
      startedAt:
        typeof parsed.startedAt === "string" ? parsed.startedAt : new Date(0).toISOString()
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function unlinkIfPresent(lockFilename: string) {
  try {
    await fs.unlink(lockFilename);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}

async function tryCreateLock(lockFilename: string, payload: LockPayload) {
  const handle = await fs.open(lockFilename, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

function describeExistingLock(lockFilename: string, existing: LockPayload | null) {
  if (!existing) {
    return `existing lock file at ${lockFilename}`;
  }

  return `pid ${existing.pid} on ${existing.hostname} (${existing.cwd}, started ${existing.startedAt})`;
}

export async function acquireSingleInstanceLock(dbFilename: string) {
  const resolvedDbFilename = path.resolve(dbFilename);
  const lockFilename = `${resolvedDbFilename}.lock`;
  const payload: LockPayload = {
    pid: process.pid,
    hostname: os.hostname(),
    cwd: process.cwd(),
    startedAt: new Date().toISOString()
  };

  await fs.mkdir(path.dirname(lockFilename), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await tryCreateLock(lockFilename, payload);
      let released = false;

      return async () => {
        if (released) {
          return;
        }

        released = true;
        await unlinkIfPresent(lockFilename);
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      const existing = await readExistingLock(lockFilename);
      if (existing && !isProcessAlive(existing.pid)) {
        await unlinkIfPresent(lockFilename);
        continue;
      }

      throw new Error(
        `Another bridge instance is already using ${resolvedDbFilename} (${describeExistingLock(
          lockFilename,
          existing
        )}). Stop the duplicate bridge process before starting a new one.`
      );
    }
  }

  throw new Error(`Failed to acquire bridge lock for ${resolvedDbFilename}`);
}
