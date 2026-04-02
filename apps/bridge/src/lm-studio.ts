import { promises as fs } from "node:fs";
import path from "node:path";

import { bridgeConfig } from "./config";

type LmModel = {
  identifier: string;
  displayName: string;
  isLoaded: boolean;
  state: string;
};

type ChatRequest = {
  model: string;
  input: string;
  previousResponseId?: string | null;
  reasoning?: "off" | "low" | "medium" | "high" | "on";
  onMessageDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
};

export type ChatResult = {
  responseId: string | null;
  text: string;
  reasoningText: string;
  outputTokens: number;
};

type HubManifest = {
  owner?: string;
  name?: string;
  dependencies?: Array<{
    sources?: Array<{
      repo?: string;
    }>;
  }>;
};

type HubModel = {
  identifier: string;
  displayName: string;
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeLookupKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function stripModelVariantSuffix(value: string) {
  return value
    .replace(/-(gguf|safetensors)$/i, "")
    .replace(/-mlx-\d+bit$/i, "")
    .replace(/-mlx$/i, "")
    .replace(/-instruct$/i, "");
}

function formatModelToken(token: string) {
  if (/^\d+(\.\d+)?b$/i.test(token)) {
    return token.toUpperCase();
  }

  if (/^\d+bit$/i.test(token)) {
    return token.toLowerCase();
  }

  if (/^qwen/i.test(token)) {
    return token.replace(/^qwen/i, "Qwen");
  }

  if (/^vl$/i.test(token)) {
    return "VL";
  }

  if (/^gguf$/i.test(token)) {
    return "GGUF";
  }

  if (/^mlx$/i.test(token)) {
    return "MLX";
  }

  return token.charAt(0).toUpperCase() + token.slice(1);
}

function humanizeModelName(value: string) {
  const base = stripModelVariantSuffix(value.split("/").pop() ?? value);
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((token) => formatModelToken(token))
    .join(" ");
}

function readModelIdentifier(model: Record<string, unknown>): string {
  const candidates = [model.key, model.identifier, model.modelKey, model.id];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return "unknown-model";
}

function readModelDisplayName(model: Record<string, unknown>): string {
  const candidates = [model.name, model.displayName, model.label];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return readModelIdentifier(model);
}

function readModelLoaded(model: Record<string, unknown>): boolean {
  if (typeof model.loaded === "boolean") {
    return model.loaded;
  }

  if (typeof model.isLoaded === "boolean") {
    return model.isLoaded;
  }

  if (typeof model.state === "string") {
    return model.state === "loaded";
  }

  return false;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function readDirectoryEntries(dirPath: string) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function loadHubModels(rootDir: string) {
  const hubModelsDir = path.join(rootDir, "hub", "models");
  const owners = await readDirectoryEntries(hubModelsDir);
  const hubModelsByRepo = new Map<string, HubModel>();

  for (const ownerEntry of owners) {
    if (!ownerEntry.isDirectory()) {
      continue;
    }

    const ownerDir = path.join(hubModelsDir, ownerEntry.name);
    const modelEntries = await readDirectoryEntries(ownerDir);

    for (const modelEntry of modelEntries) {
      if (!modelEntry.isDirectory()) {
        continue;
      }

      const manifest = await readJsonFile<HubManifest>(
        path.join(ownerDir, modelEntry.name, "manifest.json")
      );
      const owner = manifest?.owner ?? ownerEntry.name;
      const name = manifest?.name ?? modelEntry.name;
      const identifier = `${owner}/${name}`;
      const displayName = humanizeModelName(name);

      for (const dependency of manifest?.dependencies ?? []) {
        for (const source of dependency.sources ?? []) {
          if (!source.repo) {
            continue;
          }

          hubModelsByRepo.set(normalizeLookupKey(source.repo), {
            identifier,
            displayName
          });
        }
      }
    }
  }

  return hubModelsByRepo;
}

async function listDownloadedModels(): Promise<LmModel[]> {
  const rootDir = path.resolve(bridgeConfig.lmStudioConversationsDir, "..");
  const modelsDir = path.join(rootDir, "models");
  const hubModelsByRepo = await loadHubModels(rootDir);
  const ownerEntries = await readDirectoryEntries(modelsDir);
  const models = new Map<string, LmModel>();

  for (const ownerEntry of ownerEntries) {
    if (!ownerEntry.isDirectory()) {
      continue;
    }

    const ownerDir = path.join(modelsDir, ownerEntry.name);
    const modelEntries = await readDirectoryEntries(ownerDir);

    for (const modelEntry of modelEntries) {
      if (!modelEntry.isDirectory()) {
        continue;
      }

      const folderName = modelEntry.name;
      const repoMatch = hubModelsByRepo.get(normalizeLookupKey(folderName));
      const identifier =
        repoMatch?.identifier ?? stripModelVariantSuffix(folderName).toLowerCase();
      const key = normalizeLookupKey(identifier);

      models.set(key, {
        identifier,
        displayName: repoMatch?.displayName ?? humanizeModelName(folderName),
        isLoaded: false,
        state: "downloaded"
      });
    }
  }

  return [...models.values()];
}

async function listServiceModels(): Promise<LmModel[]> {
  const response = await fetch(`${bridgeConfig.lmStudioBaseUrl}/api/v1/models`);
  if (!response.ok) {
    throw new Error(`LM Studio model list failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  const models =
    asArray((payload as Record<string, unknown>).models).length > 0
      ? asArray((payload as Record<string, unknown>).models)
      : asArray(payload);

  return models
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      identifier: readModelIdentifier(entry),
      displayName: readModelDisplayName(entry),
      isLoaded: readModelLoaded(entry),
      state:
        typeof entry.state === "string"
          ? entry.state
          : readModelLoaded(entry)
            ? "loaded"
            : "discovered"
    }));
}

function mergeModels(downloadedModels: LmModel[], serviceModels: LmModel[]) {
  const merged = new Map<string, LmModel>();
  const matchedServiceKeys = new Set<string>();

  for (const downloadedModel of downloadedModels) {
    const downloadedKey = normalizeLookupKey(downloadedModel.identifier);
    const serviceMatch = serviceModels.find(
      (serviceModel) => normalizeLookupKey(serviceModel.identifier) === downloadedKey
    );

    if (serviceMatch) {
      merged.set(downloadedKey, {
        identifier: downloadedModel.identifier,
        displayName: downloadedModel.displayName,
        isLoaded: serviceMatch.isLoaded,
        state: serviceMatch.isLoaded ? "loaded" : "downloaded"
      });
      matchedServiceKeys.add(downloadedKey);
      continue;
    }

    merged.set(downloadedKey, downloadedModel);
  }

  for (const serviceModel of serviceModels) {
    const serviceKey = normalizeLookupKey(serviceModel.identifier);
    if (matchedServiceKeys.has(serviceKey)) {
      continue;
    }

    if (!serviceModel.isLoaded) {
      continue;
    }

    merged.set(serviceKey, serviceModel);
  }

  return [...merged.values()];
}

function extractOutputText(payload: unknown, outputType: "message" | "reasoning"): string {
  const root = payload as Record<string, unknown>;
  const output = asArray(root.output);
  const chunks: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    if (record.type !== outputType) {
      continue;
    }

    if (typeof record.content === "string") {
      chunks.push(record.content);
      continue;
    }

    for (const part of asArray(record.content)) {
      if (!part || typeof part !== "object") {
        continue;
      }

      const typed = part as Record<string, unknown>;
      if (typeof typed.text === "string") {
        chunks.push(typed.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

function parseSseEvent(rawBlock: string) {
  const lines = rawBlock
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  let eventType: string | null = null;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }

  if (!eventType || dataLines.length === 0) {
    return null;
  }

  return {
    eventType,
    data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>
  };
}

export async function listModels(): Promise<LmModel[]> {
  const [downloadedResult, serviceResult] = await Promise.allSettled([
    listDownloadedModels(),
    listServiceModels()
  ]);

  const downloadedModels =
    downloadedResult.status === "fulfilled" ? downloadedResult.value : [];
  const serviceModels = serviceResult.status === "fulfilled" ? serviceResult.value : [];

  const mergedModels = mergeModels(downloadedModels, serviceModels);
  if (mergedModels.length > 0) {
    return mergedModels;
  }

  if (serviceResult.status === "rejected") {
    throw serviceResult.reason;
  }

  return serviceModels;
}

export async function runChat(request: ChatRequest): Promise<ChatResult> {
  const response = await fetch(`${bridgeConfig.lmStudioBaseUrl}/api/v1/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: request.model,
      input: request.input,
      stream: true,
      ...(request.reasoning ? { reasoning: request.reasoning } : {}),
      ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {})
    })
  });

  if (!response.ok) {
    throw new Error(`LM Studio chat failed: ${response.status} ${await response.text()}`);
  }

  if (!response.body) {
    throw new Error("LM Studio chat stream did not return a response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: ChatResult | null = null;
  let streamError: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex).trim();
      buffer = buffer.slice(separatorIndex + 2);

      if (block) {
        const event = parseSseEvent(block);
        if (event) {
          if (event.eventType === "reasoning.delta" && typeof event.data.content === "string") {
            request.onReasoningDelta?.(event.data.content);
          }

          if (event.eventType === "message.delta" && typeof event.data.content === "string") {
            request.onMessageDelta?.(event.data.content);
          }

          if (event.eventType === "error") {
            const errorMessage =
              typeof event.data.error === "object" &&
              event.data.error &&
              typeof (event.data.error as Record<string, unknown>).message === "string"
                ? ((event.data.error as Record<string, unknown>).message as string)
                : "Unknown LM Studio streaming error";
            streamError = errorMessage;
          }

          if (event.eventType === "chat.end") {
            const result =
              event.data.result && typeof event.data.result === "object"
                ? (event.data.result as Record<string, unknown>)
                : null;

            if (result) {
              finalResult = {
                responseId: typeof result.response_id === "string" ? result.response_id : null,
                text: extractOutputText(result, "message"),
                reasoningText: extractOutputText(result, "reasoning"),
                outputTokens:
                  typeof (result.stats as Record<string, unknown> | undefined)
                    ?.total_output_tokens === "number"
                    ? ((result.stats as Record<string, unknown>).total_output_tokens as number)
                    : 0
              };
            }
          }
        }
      }

      separatorIndex = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode().replace(/\r\n/g, "\n");
  const trailing = buffer.trim();
  if (trailing) {
    const event = parseSseEvent(trailing);
    if (event?.eventType === "chat.end") {
      const result =
        event.data.result && typeof event.data.result === "object"
          ? (event.data.result as Record<string, unknown>)
          : null;
      if (result) {
        finalResult = {
          responseId: typeof result.response_id === "string" ? result.response_id : null,
          text: extractOutputText(result, "message"),
          reasoningText: extractOutputText(result, "reasoning"),
          outputTokens:
            typeof (result.stats as Record<string, unknown> | undefined)?.total_output_tokens ===
            "number"
              ? ((result.stats as Record<string, unknown>).total_output_tokens as number)
              : 0
        };
      }
    }
  }

  if (streamError && !finalResult) {
    throw new Error(`LM Studio chat stream failed: ${streamError}`);
  }

  if (!finalResult) {
    throw new Error("LM Studio chat stream ended without a final chat.end event");
  }

  return finalResult;
}
