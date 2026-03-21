import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

export function getConfig(overrides = {}) {
  return {
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    port: overrides.port ?? Number.parseInt(process.env.PORT ?? "8787", 10),
    lmStudioBaseUrl:
      overrides.lmStudioBaseUrl ?? process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234",
    conversationsDir:
      overrides.conversationsDir ??
      process.env.LM_STUDIO_CONVERSATIONS_DIR ??
      path.join(os.homedir(), ".lmstudio", "conversations"),
    lmApiToken: overrides.lmApiToken ?? process.env.LM_API_TOKEN
  };
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  });

  response.end(JSON.stringify(payload, null, 2));
}

function notFound(response) {
  json(response, 404, { error: "Not found" });
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function listJsonFiles(rootDir) {
  const results = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".json")) {
        results.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return results;
}

function findFirstValue(root, keys, maxDepth = 6) {
  const queue = [{ value: root, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.value === null || typeof current.value !== "object") {
      continue;
    }

    for (const key of keys) {
      if (key in current.value) {
        const value = current.value[key];
        if (value !== undefined && value !== null && value !== "") {
          return value;
        }
      }
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        queue.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }

    for (const value of Object.values(current.value)) {
      queue.push({ value, depth: current.depth + 1 });
    }
  }

  return undefined;
}

function normalizeTitle(raw, fallback) {
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }

  return fallback;
}

function normalizeDate(raw, fallback) {
  if (typeof raw === "string" || typeof raw === "number") {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return fallback;
}

function normalizeMessageCount(parsed) {
  const messages = findFirstValue(parsed, ["messages", "items", "entries"]);
  if (Array.isArray(messages)) {
    return messages.length;
  }

  return null;
}

function buildChatSummary(filePath, stats, parsed, conversationsDir) {
  const id = path.basename(filePath, ".json");
  const relativePath = path.relative(conversationsDir, filePath) || path.basename(filePath);
  const modifiedAt = stats.mtime.toISOString();
  const createdAt = stats.birthtime instanceof Date ? stats.birthtime.toISOString() : modifiedAt;

  return {
    id,
    title: normalizeTitle(
      findFirstValue(parsed, ["title", "name", "chatTitle", "label"]),
      id
    ),
    createdAt: normalizeDate(
      findFirstValue(parsed, ["createdAt", "created_at", "timestamp"]),
      createdAt
    ),
    updatedAt: normalizeDate(
      findFirstValue(parsed, ["updatedAt", "updated_at", "lastModified", "timestamp"]),
      modifiedAt
    ),
    model: findFirstValue(parsed, ["model", "modelKey", "modelName", "modelPath"]) ?? null,
    messageCount: normalizeMessageCount(parsed),
    filePath,
    relativePath,
    sizeBytes: stats.size
  };
}

export async function loadChats(conversationsDir) {
  try {
    await fs.access(conversationsDir);
  } catch {
    return [];
  }

  const files = await listJsonFiles(conversationsDir);
  const chats = [];

  for (const filePath of files) {
    try {
      const [raw, stats] = await Promise.all([
        fs.readFile(filePath, "utf8"),
        fs.stat(filePath)
      ]);
      const parsed = JSON.parse(raw);
      chats.push(buildChatSummary(filePath, stats, parsed, conversationsDir));
    } catch (error) {
      chats.push({
        id: path.basename(filePath, ".json"),
        title: path.basename(filePath, ".json"),
        createdAt: null,
        updatedAt: null,
        model: null,
        messageCount: null,
        filePath,
        relativePath: path.relative(conversationsDir, filePath) || path.basename(filePath),
        sizeBytes: null,
        parseError: error instanceof Error ? error.message : "Unknown parse error"
      });
    }
  }

  chats.sort((a, b) => {
    const left = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const right = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    return right - left;
  });

  return chats;
}

export async function loadChatById(conversationsDir, chatId) {
  const chats = await loadChats(conversationsDir);
  const chat = chats.find((entry) => entry.id === chatId);
  if (!chat) {
    return null;
  }

  const raw = await fs.readFile(chat.filePath, "utf8");
  const parsed = JSON.parse(raw);

  return {
    ...chat,
    raw: parsed
  };
}

async function proxyLmStudioChat(request, response, config) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    json(response, 400, {
      error: "Invalid JSON body",
      details: error instanceof Error ? error.message : "Unknown parse error"
    });
    return;
  }

  const headers = {
    "Content-Type": "application/json"
  };

  if (config.lmApiToken) {
    headers.Authorization = `Bearer ${config.lmApiToken}`;
  }

  const upstream = await fetch(new URL("/api/v1/chat", config.lmStudioBaseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const text = await upstream.text();
  response.writeHead(upstream.status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8"
  });
  response.end(text);
}

export function createServer(overrides = {}) {
  const config = getConfig(overrides);

  return http.createServer(async (request, response) => {
    if (!request.url || !request.method) {
      notFound(response);
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
      });
      response.end();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, {
        ok: true,
        lmStudioBaseUrl: config.lmStudioBaseUrl,
        conversationsDir: config.conversationsDir
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/chats") {
      const chats = await loadChats(config.conversationsDir);
      json(response, 200, {
        source: "filesystem",
        supportedByLmStudioApi: false,
        count: chats.length,
        chats
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/chats/")) {
      const chatId = decodeURIComponent(url.pathname.replace("/api/chats/", ""));
      const chat = await loadChatById(config.conversationsDir, chatId);
      if (!chat) {
        json(response, 404, { error: "Chat not found" });
        return;
      }

      json(response, 200, {
        source: "filesystem",
        supportedByLmStudioApi: false,
        chat
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/lmstudio/chat") {
      try {
        await proxyLmStudioChat(request, response, config);
      } catch (error) {
        json(response, 502, {
          error: "LM Studio request failed",
          details: error instanceof Error ? error.message : "Unknown upstream error"
        });
      }
      return;
    }

    notFound(response);
  });
}

export async function startServer(overrides = {}) {
  const config = getConfig(overrides);
  const server = createServer(config);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });

  console.log(`LM Studio gateway listening on http://${config.host}:${config.port}`);
  console.log(`Reading conversations from ${config.conversationsDir}`);
  console.log(`Proxying chat requests to ${config.lmStudioBaseUrl}`);

  return server;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint && import.meta.url === entrypoint) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
