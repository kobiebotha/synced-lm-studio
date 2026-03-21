import { useEffect, useMemo, useState, startTransition } from "react";
import { PowerSyncContext, usePowerSync, useQuery, useStatus } from "@powersync/react";
import type { Session } from "@supabase/supabase-js";
import {
  APP_TABLES,
  DEFAULT_CONVERSATION_TITLE,
  DEVICE_OPERATION_STATUS,
  DEVICE_OPERATION_TYPE,
  parseMessageContent,
  serializeMessageContent,
  truncateTitle
} from "@synced-lm-studio/shared";
import { webConfig } from "./config";
import { createWebDatabase } from "./powersync";
import { supabase } from "./supabase";

type AuthState = {
  session: Session | null;
  loading: boolean;
  error: string | null;
};

function useSupabaseSession() {
  const [state, setState] = useState<AuthState>({
    session: null,
    loading: true,
    error: null
  });

  useEffect(() => {
    let mounted = true;

    const initialize = async () => {
      const { data } = await supabase.auth.getSession();
      if (mounted) {
        setState({
          session: data.session,
          loading: false,
          error: null
        });
      }

      if (!data.session && webConfig.devEmail && webConfig.devPassword) {
        const { data: signedIn, error } = await supabase.auth.signInWithPassword({
          email: webConfig.devEmail,
          password: webConfig.devPassword
        });
        if (!mounted) {
          return;
        }

        setState({
          session: signedIn.session,
          loading: false,
          error: error?.message ?? null
        });
      }
    };

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) {
        return;
      }

      setState({
        session,
        loading: false,
        error: null
      });
    });

    void initialize();
    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return state;
}

function SignInCard() {
  const [email, setEmail] = useState(webConfig.devEmail);
  const [password, setPassword] = useState(webConfig.devPassword);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (signInError) {
      setError(signInError.message);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <p className="kicker">Remote Terminal</p>
        <h1>Sign in to the local stack</h1>
        <p className="lede">
          This web client uses Supabase Auth for both PowerSync credentials and direct PostgREST
          writes.
        </p>
        <label>
          <span>Email</span>
          <input value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? <p className="error-banner">{error}</p> : null}
        <button type="submit" disabled={loading}>
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

function formatRelativeTimestamp(value: string | null | undefined) {
  if (!value) {
    return "waiting";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function Workspace({ userId }: { userId: string }) {
  const db = usePowerSync();
  const status = useStatus();
  const { data: devices } = useQuery(`SELECT * FROM ${APP_TABLES.devices} ORDER BY last_seen_at DESC`);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const activeDeviceId = selectedDeviceId ?? devices[0]?.id ?? null;

  const { data: conversations } = useQuery(
    `SELECT * FROM ${APP_TABLES.conversations} WHERE (? IS NULL OR target_device_id = ?) ORDER BY COALESCE(last_message_at, created_at) DESC`,
    [activeDeviceId, activeDeviceId]
  );

  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const activeConversationId = selectedConversationId ?? conversations[0]?.id ?? null;

  const { data: messages } = useQuery(
    `SELECT * FROM ${APP_TABLES.messages} WHERE (? IS NULL OR conversation_id = ?) ORDER BY created_at ASC`,
    [activeConversationId, activeConversationId]
  );

  const { data: models } = useQuery(
    `SELECT * FROM ${APP_TABLES.deviceModels} WHERE (? IS NULL OR device_id = ?) ORDER BY is_loaded DESC, model_identifier ASC`,
    [activeDeviceId, activeDeviceId]
  );

  const { data: operations } = useQuery(
    `SELECT * FROM ${APP_TABLES.deviceOperations} WHERE (? IS NULL OR conversation_id = ?) ORDER BY created_at DESC LIMIT 20`,
    [activeConversationId, activeConversationId]
  );

  const [prompt, setPrompt] = useState("");
  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [activeConversationId, conversations]
  );

  useEffect(() => {
    if (!selectedDeviceId && devices[0]?.id) {
      setSelectedDeviceId(devices[0].id);
    }
  }, [devices, selectedDeviceId]);

  useEffect(() => {
    if (!selectedConversationId && conversations[0]?.id) {
      setSelectedConversationId(conversations[0].id);
    }
  }, [conversations, selectedConversationId]);

  const sendPrompt = async () => {
    if (!activeDeviceId || !prompt.trim()) {
      return;
    }

    const now = new Date().toISOString();
    const conversationId = activeConversationId ?? crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const title = selectedConversation?.title ?? truncateTitle(prompt, 40);

    await db.writeTransaction(async (tx) => {
      if (!activeConversationId) {
        await tx.execute(
          `
            INSERT INTO ${APP_TABLES.conversations}
              (id, owner_user_id, target_device_id, title, status, metadata_json, created_at, updated_at, last_message_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            conversationId,
            userId,
            activeDeviceId,
            title || DEFAULT_CONVERSATION_TITLE,
            "active",
            JSON.stringify({}),
            now,
            now,
            now
          ]
        );
      }

      await tx.execute(
        `
          INSERT INTO ${APP_TABLES.messages}
            (id, conversation_id, role, content_json, source, model_identifier, token_count, lmstudio_response_id, error_text, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          messageId,
          conversationId,
          "user",
          serializeMessageContent(prompt.trim()),
          "app",
          null,
          Math.max(8, Math.ceil(prompt.trim().length / 4)),
          null,
          null,
          now,
          now
        ]
      );

      await tx.execute(
        `
          INSERT INTO ${APP_TABLES.deviceOperations}
            (id, device_id, conversation_id, requested_by_user_id, type, payload_json, status, error_text, created_at, claimed_at, completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          operationId,
          activeDeviceId,
          conversationId,
          userId,
          DEVICE_OPERATION_TYPE.sendMessage,
          JSON.stringify({
            user_message_id: messageId,
            materialize_sidebar: true
          }),
          DEVICE_OPERATION_STATUS.pending,
          null,
          now,
          null,
          null,
          now
        ]
      );
    });

    setPrompt("");
    startTransition(() => {
      setSelectedConversationId(conversationId);
    });
  };

  const queueRefreshModels = async () => {
    if (!activeDeviceId) {
      return;
    }

    const now = new Date().toISOString();
    await db.execute(
      `
        INSERT INTO ${APP_TABLES.deviceOperations}
          (id, device_id, conversation_id, requested_by_user_id, type, payload_json, status, error_text, created_at, claimed_at, completed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        crypto.randomUUID(),
        activeDeviceId,
        null,
        userId,
        DEVICE_OPERATION_TYPE.refreshModels,
        JSON.stringify({}),
        DEVICE_OPERATION_STATUS.pending,
        null,
        now,
        null,
        null,
        now
      ]
    );
  };

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="panel">
          <p className="kicker">Device</p>
          <h2>LM Studio bridge</h2>
          <p className="status-pill">
            {status.connected ? "PowerSync connected" : "PowerSync reconnecting"}
          </p>
          <button onClick={queueRefreshModels} disabled={!activeDeviceId}>
            Refresh models
          </button>
          <div className="device-list">
            {devices.map((device) => (
              <button
                key={device.id}
                className={device.id === activeDeviceId ? "list-row active" : "list-row"}
                onClick={() => setSelectedDeviceId(device.id)}
              >
                <span>{device.display_name}</span>
                <small>{device.status}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="panel">
          <p className="kicker">Models</p>
          <div className="model-list">
            {models.map((model) => (
              <div className="model-row" key={model.id}>
                <span>{model.display_name || model.model_identifier}</span>
                <small>{model.is_loaded ? "loaded" : model.state}</small>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="workspace">
        <section className="conversation-panel">
          <header className="panel-header">
            <div>
              <p className="kicker">Conversations</p>
              <h1>{selectedConversation?.title ?? "Select a conversation"}</h1>
            </div>
          </header>
          <div className="conversation-list">
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                className={
                  conversation.id === activeConversationId ? "conversation-row active" : "conversation-row"
                }
                onClick={() => setSelectedConversationId(conversation.id)}
              >
                <span>{conversation.title}</span>
                <small>{formatRelativeTimestamp(conversation.updated_at)}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="chat-panel">
          <div className="messages">
            {messages.map((message) => (
              <article
                className={message.role === "assistant" ? "message assistant" : "message user"}
                key={message.id}
              >
                <p className="message-role">{message.role}</p>
                <p>{parseMessageContent(message.content_json).text}</p>
              </article>
            ))}
          </div>
          <div className="composer">
            <textarea
              placeholder="Send a prompt to the selected LM Studio bridge…"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <button onClick={sendPrompt} disabled={!activeDeviceId || !prompt.trim()}>
              Send
            </button>
          </div>
        </section>

        <section className="operations-panel">
          <header className="panel-header">
            <div>
              <p className="kicker">Operations</p>
              <h2>Bridge activity</h2>
            </div>
          </header>
          <div className="operation-list">
            {operations.map((operation) => (
              <div className="operation-row" key={operation.id}>
                <span>{operation.type}</span>
                <small>{operation.status}</small>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

export default function App() {
  const auth = useSupabaseSession();
  const [database, setDatabase] = useState<Awaited<ReturnType<typeof createWebDatabase>> | null>(null);
  const [databaseError, setDatabaseError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    if (!auth.session) {
      setDatabase(null);
      return;
    }

    void createWebDatabase(supabase)
      .then((db) => {
        if (!mounted) {
          return;
        }

        setDatabase(db);
        setDatabaseError(null);
      })
      .catch((error) => {
        if (!mounted) {
          return;
        }

        setDatabaseError(error instanceof Error ? error.message : "Failed to initialize PowerSync");
      });

    return () => {
      mounted = false;
    };
  }, [auth.session]);

  if (auth.loading) {
    return <div className="auth-shell">Loading authentication…</div>;
  }

  if (!auth.session) {
    return <SignInCard />;
  }

  if (databaseError) {
    return <div className="auth-shell error-banner">{databaseError}</div>;
  }

  if (!database) {
    return <div className="auth-shell">Connecting PowerSync…</div>;
  }

  return (
    <PowerSyncContext.Provider value={database}>
      <Workspace userId={auth.session.user.id} />
    </PowerSyncContext.Provider>
  );
}
