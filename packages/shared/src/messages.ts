export type MessageContent = {
  text: string;
};

export function serializeMessageContent(text: string): string {
  return JSON.stringify({ text });
}

export function parseMessageContent(raw: string | null | undefined): MessageContent {
  if (!raw) {
    return { text: "" };
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") {
      return { text: parsed };
    }

    if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
      return { text: parsed.text };
    }
  } catch {
    return { text: raw };
  }

  return { text: "" };
}

export function truncateTitle(input: string, maxLength = 64): string {
  const collapsed = input.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed || "New conversation";
  }

  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}
