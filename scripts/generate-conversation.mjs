#!/usr/bin/env node

import path from "node:path";
import { promises as fs } from "node:fs";

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/generate-conversation.mjs \\",
      "    --template /path/to/template.conversation.json \\",
      "    --out-dir /tmp/out \\",
      "    --name \"Sidebar PoC\" \\",
      "    --user \"hello\" \\",
      "    --assistant \"hi there\" \\",
      "    --model \"qwen/qwen3-vl-8b\""
    ].join("\n")
  );
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function approximateTokenCount(...texts) {
  const totalChars = texts
    .filter((text) => typeof text === "string")
    .reduce((sum, text) => sum + text.length, 0);

  return Math.max(8, Math.ceil(totalChars / 4));
}

function rewriteMessagePair(conversation, userText, assistantText, model, now) {
  const [userMessage, assistantMessage] = cloneJson(conversation.messages ?? []);
  if (!userMessage || !assistantMessage) {
    throw new Error("Template conversation must contain at least one user and one assistant message.");
  }

  userMessage.currentlySelected = 0;
  userMessage.versions = userMessage.versions ?? [];
  userMessage.versions[0] = userMessage.versions[0] ?? { type: "singleStep", role: "user" };
  userMessage.versions[0].type = "singleStep";
  userMessage.versions[0].role = "user";
  userMessage.versions[0].content = [{ type: "text", text: userText }];
  if (userMessage.versions[0].preprocessed) {
    userMessage.versions[0].preprocessed = {
      role: "user",
      content: [{ type: "text", text: userText }]
    };
  }

  assistantMessage.currentlySelected = 0;
  assistantMessage.versions = assistantMessage.versions ?? [];
  assistantMessage.versions[0] = assistantMessage.versions[0] ?? { type: "multiStep", role: "assistant" };
  assistantMessage.versions[0].type = "multiStep";
  assistantMessage.versions[0].role = "assistant";
  assistantMessage.versions[0].senderInfo = {
    ...(assistantMessage.versions[0].senderInfo ?? {}),
    senderName: model
  };

  const steps = assistantMessage.versions[0].steps ?? [];
  const thinkingStep = steps.find(
    (step) => step?.type === "contentBlock" && step?.style?.type === "thinking"
  );
  if (thinkingStep) {
    thinkingStep.stepIdentifier = `${now + 1}-0.1000000000000000`;
    thinkingStep.content = [
      {
        type: "text",
        text: "Synthetic PoC conversation generated from a real LM Studio cache file.",
        fromDraftModel: false,
        tokensCount: 15,
        isStructural: false
      }
    ];
  }

  const finalStep = [...steps]
    .reverse()
    .find((step) => step?.type === "contentBlock" && Array.isArray(step?.content));
  if (!finalStep) {
    throw new Error("Template assistant message does not contain a contentBlock step.");
  }

  finalStep.stepIdentifier = `${now + 2}-0.2000000000000000`;
  const originalFinalContent = cloneJson(finalStep.content ?? []);
  const structuralPrefix = originalFinalContent.find(
    (item) => item?.type === "text" && item?.isStructural === true
  );
  if (structuralPrefix) {
    finalStep.content = originalFinalContent.map((item) => {
      if (item?.type !== "text" || item?.isStructural === true) {
        return item;
      }
      return {
        ...item,
        text: assistantText,
        tokensCount: approximateTokenCount(assistantText),
        fromDraftModel: false,
        isStructural: false
      };
    });
  } else {
    finalStep.content = [
      {
        type: "text",
        text: assistantText,
        fromDraftModel: false,
        tokensCount: approximateTokenCount(assistantText),
        isStructural: false
      }
    ];
  }

  if (finalStep.genInfo) {
    finalStep.genInfo.identifier = model;
    finalStep.genInfo.indexedModelIdentifier = model;
  }

  for (const step of steps) {
    if (step?.type === "debugInfoBlock") {
      step.stepIdentifier = `${now + 3}-0.3000000000000000`;
      step.debugInfo = "Conversation naming technique: 'manual-poC'";
    }
  }

  return [userMessage, assistantMessage];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const templatePath = args.template;
  const outDir = args["out-dir"] ?? process.cwd();
  const name = args.name ?? "Synthetic Sidebar PoC";
  const userText = args.user ?? "User message placeholder";
  const assistantText = args.assistant ?? "Assistant reply placeholder";
  const model = args.model ?? "qwen/qwen3-vl-8b";

  if (!templatePath) {
    usage();
    process.exitCode = 1;
    return;
  }

  const templateRaw = await fs.readFile(templatePath, "utf8");
  const template = JSON.parse(templateRaw);
  const now = Date.now();
  const conversation = cloneJson(template);

  conversation.name = name;
  conversation.createdAt = now;
  conversation.pinned = false;
  conversation.tokenCount = approximateTokenCount(userText, assistantText);
  conversation.userLastMessagedAt = now + 1000;
  conversation.assistantLastMessagedAt = now + 2000;
  conversation.systemPrompt = conversation.systemPrompt ?? "";
  conversation.preset = conversation.preset ?? "";
  conversation.clientInput = "";
  conversation.clientInputFiles = [];
  conversation.looseFiles = [];
  conversation.notes = [];
  conversation.disabledPluginTools = [];
  conversation.pluginConfigs = {};
  conversation.plugins = [];
  conversation.usePerChatPredictionConfig = conversation.usePerChatPredictionConfig ?? true;
  conversation.userFilesSizeBytes = 0;

  if (conversation.lastUsedModel) {
    conversation.lastUsedModel.identifier = model;
    conversation.lastUsedModel.indexedModelIdentifier = model;
  }

  conversation.messages = rewriteMessagePair(conversation, userText, assistantText, model, now);

  const outPath = path.join(outDir, `${now}.conversation.json`);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(conversation, null, 2)}\n`, "utf8");

  console.log(outPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
