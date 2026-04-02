export type MessageContent = {
  text: string;
  reasoningText: string;
};

type SerializeMessageContentInput =
  | string
  | {
      text?: string | null;
      reasoningText?: string | null;
    };

export function serializeMessageContent(
  input: SerializeMessageContentInput,
  reasoningText?: string | null
): string {
  const content =
    typeof input === "string"
      ? {
          text: input,
          reasoningText: reasoningText ?? ""
        }
      : {
          text: input.text ?? "",
          reasoningText: input.reasoningText ?? ""
        };

  if (!content.reasoningText) {
    return JSON.stringify({ text: content.text });
  }

  return JSON.stringify(content);
}

export function parseMessageContent(raw: string | null | undefined): MessageContent {
  if (!raw) {
    return { text: "", reasoningText: "" };
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") {
      return { text: parsed, reasoningText: "" };
    }

    if (parsed && typeof parsed === "object") {
      return {
        text: typeof parsed.text === "string" ? parsed.text : "",
        reasoningText: typeof parsed.reasoningText === "string" ? parsed.reasoningText : ""
      };
    }
  } catch {
    return { text: raw, reasoningText: "" };
  }

  return { text: "", reasoningText: "" };
}

export function truncateTitle(input: string, maxLength = 64): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed || "New conversation";
  }

  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}
