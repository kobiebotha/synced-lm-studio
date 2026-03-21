export const APP_TABLES = {
  devices: "devices",
  deviceModels: "device_models",
  conversations: "conversations",
  messages: "messages",
  lmstudioThreads: "lmstudio_threads",
  deviceOperations: "device_operations",
  operationEvents: "operation_events",
  localUploadErrors: "local_upload_errors"
} as const;

export const DEFAULT_CONVERSATION_TITLE = "New conversation";

export const DEVICE_OPERATION_TYPE = {
  refreshModels: "refresh_models",
  sendMessage: "send_message"
} as const;

export const DEVICE_OPERATION_STATUS = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed"
} as const;

export const DEVICE_STATUS = {
  online: "online",
  offline: "offline"
} as const;

export const MESSAGE_ROLE = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool"
} as const;

export const MESSAGE_SOURCE = {
  app: "app",
  bridge: "bridge",
  lmStudio: "lmstudio"
} as const;

export const BOOLEAN_COLUMNS: Record<string, readonly string[]> = {
  [APP_TABLES.deviceModels]: ["is_loaded"]
};
