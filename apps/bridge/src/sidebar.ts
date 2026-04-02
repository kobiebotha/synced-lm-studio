import path from "node:path";
import { promises as fs } from "node:fs";
import { parseMessageContent } from "@synced-lm-studio/shared";

type CanonicalMessage = {
  id: string;
  role: string;
  content_json: string;
  model_identifier: string | null;
  token_count: number | null;
  created_at: string;
};

export type ImportedConversationFileMessage = {
  role: "user" | "assistant";
  text: string;
  modelIdentifier: string | null;
  tokenCount: number | null;
  timestampMs: number | null;
};

export type ImportedConversationFile = {
  title: string;
  modelIdentifier: string | null;
  createdAtMs: number | null;
  lastActivityAtMs: number | null;
  messages: ImportedConversationFileMessage[];
};

function approximateTokens(text: string): number {
  return Math.max(8, Math.ceil(text.length / 4));
}

function millis(timestamp: string | null | undefined, fallback: number): number {
  if (!timestamp) {
    return fallback;
  }

  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toUserMessage(text: string) {
  return {
    versions: [
      {
        type: "singleStep",
        role: "user",
        content: [{ type: "text", text }],
        preprocessed: {
          role: "user",
          content: [{ type: "text", text }]
        }
      }
    ],
    currentlySelected: 0
  };
}

function extractTextParts(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const text = "text" in item && typeof item.text === "string" ? item.text : null;
      return text ? [text] : [];
    })
    .filter(Boolean);
}

function pickVersion(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const message = raw as Record<string, any>;
  const versions = Array.isArray(message.versions) ? message.versions : [];
  if (versions.length === 0) {
    return null;
  }

  const selected =
    typeof message.currentlySelected === "number" && versions[message.currentlySelected]
      ? versions[message.currentlySelected]
      : versions[0];

  return selected && typeof selected === "object" ? (selected as Record<string, any>) : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const match = value.match(/(\d{10,})/);
    if (match) {
      const parsed = Number.parseInt(match[1], 10);
      return Number.isNaN(parsed) ? null : parsed;
    }
  }

  return null;
}

function parseUserMessage(raw: unknown): ImportedConversationFileMessage | null {
  const version = pickVersion(raw);
  if (!version || version.role !== "user") {
    return null;
  }

  const textParts = [
    ...extractTextParts(version.content),
    ...extractTextParts(version.preprocessed?.content)
  ];
  const text = textParts.find((part) => part.trim().length > 0)?.trim() ?? "";
  if (!text) {
    return null;
  }

  return {
    role: "user",
    text,
    modelIdentifier: null,
    tokenCount: approximateTokens(text),
    timestampMs: null
  };
}

function parseAssistantMessage(
  raw: unknown,
  fallbackModelIdentifier: string | null
): ImportedConversationFileMessage | null {
  const version = pickVersion(raw);
  if (!version || version.role !== "assistant") {
    return null;
  }

  const steps = Array.isArray(version.steps) ? version.steps : [];
  const textParts: string[] = [];
  const timestamps: number[] = [];
  let modelIdentifier =
    typeof version.senderInfo?.senderName === "string" ? version.senderInfo.senderName : null;
  let tokenCount = 0;

  for (const step of steps) {
    if (!step || typeof step !== "object") {
      continue;
    }

    const typedStep = step as Record<string, any>;
    if (typedStep.type !== "contentBlock") {
      continue;
    }

    timestamps.push(...[parseTimestamp(typedStep.stepIdentifier)].filter((value): value is number => value != null));
    textParts.push(...extractTextParts(typedStep.content));

    if (!modelIdentifier && typeof typedStep.genInfo?.identifier === "string") {
      modelIdentifier = typedStep.genInfo.identifier;
    }

    if (Array.isArray(typedStep.content)) {
      for (const contentItem of typedStep.content) {
        if (
          contentItem &&
          typeof contentItem === "object" &&
          typeof (contentItem as Record<string, any>).tokensCount === "number"
        ) {
          tokenCount += (contentItem as Record<string, any>).tokensCount as number;
        }
      }
    }
  }

  const text = textParts.join("\n").trim();
  if (!text) {
    return null;
  }

  return {
    role: "assistant",
    text,
    modelIdentifier: modelIdentifier ?? fallbackModelIdentifier,
    tokenCount: tokenCount > 0 ? tokenCount : approximateTokens(text),
    timestampMs: timestamps.length > 0 ? Math.max(...timestamps) : null
  };
}

function parseConversationMessages(raw: unknown): ImportedConversationFileMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const messages: ImportedConversationFileMessage[] = [];
  for (const entry of raw) {
    const userMessage = parseUserMessage(entry);
    if (userMessage) {
      messages.push(userMessage);
      continue;
    }

    const assistantMessage = parseAssistantMessage(entry, null);
    if (assistantMessage) {
      messages.push(assistantMessage);
    }
  }

  return messages;
}

function toAssistantMessage(text: string, model: string, timestamp: number) {
  return {
    versions: [
      {
        type: "multiStep",
        role: "assistant",
        senderInfo: {
          senderName: model
        },
        steps: [
          {
            type: "contentBlock",
            stepIdentifier: `${timestamp}-content`,
            content: [
              {
                type: "text",
                text,
                fromDraftModel: false,
                tokensCount: approximateTokens(text),
                isStructural: false
              }
            ],
            defaultShouldIncludeInContext: true,
            shouldIncludeInContext: true,
            genInfo: {
              indexedModelIdentifier: model,
              identifier: model,
              loadModelConfig: {
                fields: []
              },
              predictionConfig: {
                fields: []
              }
            }
          },
          {
            type: "debugInfoBlock",
            stepIdentifier: `${timestamp}-debug`,
            debugInfo: "Conversation naming technique: 'bridge'"
          }
        ]
      }
    ],
    currentlySelected: 0
  };
}

function buildConversationPayload(
  title: string,
  modelIdentifier: string,
  messages: CanonicalMessage[],
  createdAt: string
) {
  const createdAtMs = millis(createdAt, Date.now());
  let userLastMessagedAt = createdAtMs;
  let assistantLastMessagedAt = createdAtMs;

  const sidebarMessages = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      const text = parseMessageContent(message.content_json).text;
      const timestamp = millis(message.created_at, Date.now());

      if (message.role === "user") {
        userLastMessagedAt = timestamp;
        return toUserMessage(text);
      }

      assistantLastMessagedAt = timestamp;
      return toAssistantMessage(text, message.model_identifier ?? modelIdentifier, timestamp);
    });

  const tokenCount = messages.reduce((sum, message) => {
    if (typeof message.token_count === "number" && message.token_count > 0) {
      return sum + message.token_count;
    }

    return sum + approximateTokens(parseMessageContent(message.content_json).text);
  }, 0);

  return {
    name: title,
    pinned: false,
    createdAt: createdAtMs,
    preset: "",
    tokenCount,
    userLastMessagedAt,
    assistantLastMessagedAt,
    systemPrompt: "",
    lastUsedModel: {
      indexedModelIdentifier: modelIdentifier,
      identifier: modelIdentifier,
      instanceLoadTimeConfig: {
        fields: []
      },
      instanceOperationTimeConfig: {
        fields: []
      }
    },
    clientInput: "",
    clientInputFiles: [],
    looseFiles: [],
    notes: [],
    perChatPredictionConfig: {
      fields: []
    },
    disabledPluginTools: [],
    pluginConfigs: {},
    plugins: [],
    usePerChatPredictionConfig: false,
    userFilesSizeBytes: 0,
    messages: sidebarMessages
  };
}

export async function materializeConversationFile(params: {
  cacheDir: string;
  cacheFilename: string;
  title: string;
  createdAt: string;
  modelIdentifier: string;
  messages: CanonicalMessage[];
}) {
  await fs.mkdir(params.cacheDir, { recursive: true });
  const target = path.join(params.cacheDir, params.cacheFilename);
  const payload = buildConversationPayload(
    params.title,
    params.modelIdentifier,
    params.messages,
    params.createdAt
  );
  await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return target;
}

export async function readConversationFile(filePath: string): Promise<ImportedConversationFile | null> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, any>;
  const activityCandidates = [
    parsed.createdAt,
    parsed.userLastMessagedAt,
    parsed.assistantLastMessagedAt
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  return {
    title: typeof parsed.name === "string" && parsed.name.trim().length > 0 ? parsed.name.trim() : "New conversation",
    modelIdentifier:
      typeof parsed.lastUsedModel?.identifier === "string" ? parsed.lastUsedModel.identifier : null,
    createdAtMs:
      typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt) ? parsed.createdAt : null,
    lastActivityAtMs: activityCandidates.length > 0 ? Math.max(...activityCandidates) : null,
    messages: parseConversationMessages(parsed.messages)
  };
}
