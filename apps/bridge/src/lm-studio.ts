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
};

export type ChatResult = {
  responseId: string | null;
  text: string;
  outputTokens: number;
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function extractAssistantText(payload: unknown): string {
  const root = payload as Record<string, unknown>;
  const output = asArray(root.output);
  const chunks: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
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

export async function listModels(): Promise<LmModel[]> {
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

export async function runChat(request: ChatRequest): Promise<ChatResult> {
  const response = await fetch(`${bridgeConfig.lmStudioBaseUrl}/api/v1/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: request.model,
      input: request.input,
      ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {})
    })
  });

  if (!response.ok) {
    throw new Error(`LM Studio chat failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return {
    responseId: typeof payload.response_id === "string" ? payload.response_id : null,
    text: extractAssistantText(payload),
    outputTokens:
      typeof (payload.stats as Record<string, unknown> | undefined)?.total_output_tokens === "number"
        ? ((payload.stats as Record<string, unknown>).total_output_tokens as number)
        : 0
  };
}
