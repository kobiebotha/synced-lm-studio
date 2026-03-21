import path from "node:path";
import { loadChats, loadChatById } from "../src/server.mjs";

const fixturesDir = path.resolve("testdata", "conversations");

const chats = await loadChats(fixturesDir);
if (chats.length !== 2) {
  throw new Error(`Expected 2 chats, got ${chats.length}`);
}

if (chats[0].id !== "chat-newer") {
  throw new Error(`Expected newest chat first, got ${chats[0].id}`);
}

if (chats[0].title !== "Newer fixture chat") {
  throw new Error(`Expected extracted title, got ${chats[0].title}`);
}

if (chats[0].messageCount !== 3) {
  throw new Error(`Expected 3 messages, got ${chats[0].messageCount}`);
}

const chat = await loadChatById(fixturesDir, "chat-older");
if (!chat) {
  throw new Error("Expected chat-older to load");
}

if (chat.title !== "Older fixture chat") {
  throw new Error(`Expected chat title to round-trip, got ${chat.title}`);
}

console.log("Smoke test passed");
