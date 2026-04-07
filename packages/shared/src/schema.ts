import { column, Schema, Table } from "@powersync/common";
import { APP_TABLES } from "./constants";

export const devices = new Table(
  {
    owner_user_id: column.text,
    machine_key: column.text,
    display_name: column.text,
    status: column.text,
    pairing_status: column.text,
    pairing_code: column.text,
    platform: column.text,
    bridge_version: column.text,
    metadata_json: column.text,
    paired_at: column.text,
    last_seen_at: column.text,
    created_at: column.text,
    updated_at: column.text
  },
  {
    indexes: {
      owner: ["owner_user_id"],
      machine: ["machine_key"],
      status: ["status"],
      pairing: ["pairing_status"]
    }
  }
);

export const deviceModels = new Table(
  {
    device_id: column.text,
    model_identifier: column.text,
    display_name: column.text,
    is_loaded: column.integer,
    state: column.text,
    discovered_at: column.text,
    updated_at: column.text
  },
  {
    indexes: {
      device: ["device_id"],
      identifier: ["model_identifier"]
    }
  }
);

export const conversations = new Table(
  {
    owner_user_id: column.text,
    target_device_id: column.text,
    title: column.text,
    status: column.text,
    metadata_json: column.text,
    share_token: column.text,
    shared_at: column.text,
    created_at: column.text,
    updated_at: column.text,
    last_message_at: column.text
  },
  {
    indexes: {
      owner: ["owner_user_id"],
      device: ["target_device_id"],
      shareToken: ["share_token"],
      updated: ["updated_at"]
    }
  }
);

export const messages = new Table(
  {
    conversation_id: column.text,
    role: column.text,
    content_json: column.text,
    source: column.text,
    model_identifier: column.text,
    token_count: column.integer,
    lmstudio_response_id: column.text,
    error_text: column.text,
    created_at: column.text,
    updated_at: column.text
  },
  {
    indexes: {
      conversation: ["conversation_id"],
      created: ["created_at"]
    }
  }
);

export const lmstudioThreads = new Table(
  {
    conversation_id: column.text,
    device_id: column.text,
    current_response_id: column.text,
    model_identifier: column.text,
    cache_filename: column.text,
    last_synced_at: column.text,
    created_at: column.text,
    updated_at: column.text
  },
  {
    indexes: {
      conversation: ["conversation_id"],
      device: ["device_id"]
    }
  }
);

export const deviceOperations = new Table(
  {
    device_id: column.text,
    conversation_id: column.text,
    requested_by_user_id: column.text,
    type: column.text,
    payload_json: column.text,
    status: column.text,
    error_text: column.text,
    created_at: column.text,
    claimed_at: column.text,
    completed_at: column.text,
    updated_at: column.text
  },
  {
    indexes: {
      device: ["device_id"],
      conversation: ["conversation_id"],
      status: ["status"]
    }
  }
);

export const operationEvents = new Table(
  {
    operation_id: column.text,
    device_id: column.text,
    event_type: column.text,
    payload_json: column.text,
    created_at: column.text
  },
  {
    indexes: {
      operation: ["operation_id"],
      device: ["device_id"]
    }
  }
);

export const localUploadErrors = new Table(
  {
    scope: column.text,
    table_name: column.text,
    record_id: column.text,
    message: column.text,
    details: column.text,
    created_at: column.text
  },
  {
    localOnly: true,
    indexes: {
      created: ["created_at"]
    }
  }
);

export const AppSchema = new Schema({
  [APP_TABLES.devices]: devices,
  [APP_TABLES.deviceModels]: deviceModels,
  [APP_TABLES.conversations]: conversations,
  [APP_TABLES.messages]: messages,
  [APP_TABLES.lmstudioThreads]: lmstudioThreads,
  [APP_TABLES.deviceOperations]: deviceOperations,
  [APP_TABLES.operationEvents]: operationEvents,
  [APP_TABLES.localUploadErrors]: localUploadErrors
});

export type AppDatabase = (typeof AppSchema)["types"];
