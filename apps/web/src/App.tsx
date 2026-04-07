import { useEffect, useMemo, useRef, useState, startTransition } from "react";
import { PowerSyncContext, usePowerSync, useQuery, useStatus } from "@powersync/react";
import type { Session } from "@supabase/supabase-js";
import ReactMarkdown from "react-markdown";
import {
  APP_TABLES,
  OPERATION_EVENT_TYPE,
  DEFAULT_CONVERSATION_TITLE,
  DEVICE_PAIRING_STATUS,
  DEVICE_OPERATION_STATUS,
  DEVICE_OPERATION_TYPE,
  parseMessageContent,
  serializeMessageContent,
  truncateTitle,
  type AppDatabase
} from "@synced-lm-studio/shared";
import { webConfig } from "./config";
import { createWebDatabase } from "./powersync";
import { supabase } from "./supabase";

type AuthState = {
  session: Session | null;
  loading: boolean;
  error: string | null;
};

type MessageRow = AppDatabase["messages"];
type DeviceOperationRow = AppDatabase["device_operations"];
type OperationEventJoinRow = AppDatabase["operation_events"] & {
  conversation_id: string | null;
  operation_type: string | null;
  operation_status: string | null;
  operation_created_at: string | null;
};

type OperationBenchmark = {
  operationId: string;
  status: string | null | undefined;
  submittedAt: string | null;
  bridgeMessageSeenAt: string | null;
  runningAt: string | null;
  bridgeResponseWrittenAt: string | null;
  renderedAt: string | null;
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
      const { data, error } = await supabase.auth.getSession();
      if (!mounted) {
        return;
      }

      setState({
        session: data.session,
        loading: false,
        error: error?.message ?? null
      });
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

function AuthCard() {
  const [mode, setMode] = useState<"sign_in" | "sign_up">("sign_in");
  const [email, setEmail] = useState(webConfig.devEmail);
  const [password, setPassword] = useState(webConfig.devPassword);
  const [confirmPassword, setConfirmPassword] = useState(webConfig.devPassword);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    if (mode === "sign_up" && password !== confirmPassword) {
      setLoading(false);
      setError("Passwords do not match");
      return;
    }

    if (mode === "sign_up") {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password
      });
      setLoading(false);
      if (signUpError) {
        setError(signUpError.message);
        return;
      }

      if (!data.session) {
        setMessage("Sign-up submitted. Confirm the account if email confirmation is enabled.");
      }
      return;
    }

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
        <h1>{mode === "sign_in" ? "Sign in to your workspace" : "Create an account"}</h1>
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
        {mode === "sign_up" ? (
          <label>
            <span>Confirm password</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>
        ) : null}
        {error ? <p className="error-banner">{error}</p> : null}
        {message ? <p className="status-pill">{message}</p> : null}
        <button type="submit" disabled={loading}>
          {loading
            ? mode === "sign_in"
              ? "Signing in…"
              : "Creating account…"
            : mode === "sign_in"
              ? "Sign in"
              : "Sign up"}
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            setMode((current) => (current === "sign_in" ? "sign_up" : "sign_in"));
            setError(null);
            setMessage(null);
          }}
        >
          {mode === "sign_in" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}

function SetupCard({
  title,
  description,
  detail
}: {
  title: string;
  description: string;
  detail?: string | null;
}) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <p className="kicker">PowerSync</p>
        <h1>{title}</h1>
        <p className="lede">{description}</p>
        {detail ? <p className="error-banner">{detail}</p> : null}
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            void supabase.auth.signOut();
          }}
        >
          Sign out
        </button>
      </div>
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

function nextPairingCode() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
}

type ReasoningMode = "off" | "low" | "medium" | "high" | "on";

const REASONING_OPTIONS: Array<{ value: ReasoningMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "on", label: "Extra High" }
];

function readStoredReasoningMode(): ReasoningMode {
  if (typeof window === "undefined") {
    return "on";
  }

  const raw = window.localStorage.getItem("synced-lm-studio:reasoning-mode");
  if (raw === "off" || raw === "low" || raw === "medium" || raw === "high" || raw === "on") {
    return raw;
  }

  return "on";
}

function ensureJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function diffMs(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) {
    return null;
  }

  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return null;
  }

  return Math.max(0, endMs - startMs);
}

function formatDuration(durationMs: number | null) {
  if (durationMs == null) {
    return "waiting";
  }

  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }

  return `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 1 : 2)} s`;
}

function findOperationEvent(
  events: ReadonlyArray<OperationEventJoinRow>,
  operationId: string,
  eventType: string
) {
  return events.find(
    (event) => event.operation_id === operationId && event.event_type === eventType
  );
}

function readAssistantMessageId(
  events: ReadonlyArray<OperationEventJoinRow>,
  operationId: string
) {
  const responseWrittenEvent = findOperationEvent(
    events,
    operationId,
    OPERATION_EVENT_TYPE.benchmarkBridgeResponseWritten
  );
  const completedEvent = findOperationEvent(events, operationId, OPERATION_EVENT_TYPE.completed);

  for (const event of [responseWrittenEvent, completedEvent]) {
    const payload = ensureJson<{ assistant_message_id?: string }>(event?.payload_json, {});
    if (payload.assistant_message_id) {
      return payload.assistant_message_id;
    }
  }

  return null;
}

function buildOperationBenchmarks(
  operations: ReadonlyArray<DeviceOperationRow>,
  events: ReadonlyArray<OperationEventJoinRow>
) {
  return operations
    .filter((operation) => operation.type === DEVICE_OPERATION_TYPE.sendMessage)
    .map((operation): OperationBenchmark => ({
      operationId: operation.id,
      status: operation.status,
      submittedAt:
        findOperationEvent(events, operation.id, OPERATION_EVENT_TYPE.benchmarkWebSubmit)
          ?.created_at ?? operation.created_at ?? null,
      bridgeMessageSeenAt:
        findOperationEvent(events, operation.id, OPERATION_EVENT_TYPE.benchmarkBridgeMessageSeen)
          ?.created_at ?? null,
      runningAt: findOperationEvent(events, operation.id, OPERATION_EVENT_TYPE.running)?.created_at ?? null,
      bridgeResponseWrittenAt:
        findOperationEvent(events, operation.id, OPERATION_EVENT_TYPE.benchmarkBridgeResponseWritten)
          ?.created_at ?? null,
      renderedAt:
        findOperationEvent(events, operation.id, OPERATION_EVENT_TYPE.benchmarkWebResponseRendered)
          ?.created_at ?? null
    }));
}

function AssistantMessage({
  contentJson
}: {
  contentJson: string | null | undefined;
}) {
  const { text, reasoningText } = parseMessageContent(contentJson);
  const hasReasoning = reasoningText.trim().length > 0;
  const hasText = text.trim().length > 0;

  return (
    <div className="assistant-message">
      {hasReasoning ? (
        <details className="message-thinking" open>
          <summary>Thinking</summary>
          <div className="message-thinking-body">
            <ReactMarkdown>{reasoningText}</ReactMarkdown>
          </div>
        </details>
      ) : null}
      {hasText ? (
        <div className="message-body">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      ) : null}
    </div>
  );
}

function OperationBenchmarkCard({ benchmark }: { benchmark: OperationBenchmark }) {
  const syncToBridgeMs = diffMs(benchmark.submittedAt, benchmark.bridgeMessageSeenAt);
  const bridgeToResponseSqliteMs = diffMs(
    benchmark.bridgeMessageSeenAt,
    benchmark.bridgeResponseWrittenAt
  );
  const responseToRenderMs = diffMs(benchmark.bridgeResponseWrittenAt, benchmark.renderedAt);
  const totalRoundTripMs = diffMs(benchmark.submittedAt, benchmark.renderedAt);
  const bridgePickupMs = diffMs(benchmark.bridgeMessageSeenAt, benchmark.runningAt);
  const modelRuntimeMs = diffMs(benchmark.runningAt, benchmark.bridgeResponseWrittenAt);
  const phaseLabel =
    benchmark.renderedAt != null
      ? "visible in UI"
      : benchmark.bridgeResponseWrittenAt != null
        ? "syncing back to web"
        : benchmark.bridgeMessageSeenAt != null
          ? "inferencing"
          : "syncing to bridge";

  return (
    <article className="benchmark-card">
      <div className="benchmark-header">
        <span>Send message</span>
        <small>
          {benchmark.status ?? "unknown"} · {phaseLabel}
        </small>
      </div>
      <dl className="benchmark-metrics">
        <div>
          <dt>Web submit → bridge SQLite</dt>
          <dd>{formatDuration(syncToBridgeMs)}</dd>
        </div>
        <div>
          <dt>Bridge SQLite → response SQLite</dt>
          <dd>{formatDuration(bridgeToResponseSqliteMs)}</dd>
        </div>
        <div>
          <dt>Response SQLite → web UI</dt>
          <dd>{formatDuration(responseToRenderMs)}</dd>
        </div>
        <div>
          <dt>Total round trip</dt>
          <dd>{formatDuration(totalRoundTripMs)}</dd>
        </div>
      </dl>
      <p className="benchmark-detail">
        Bridge pickup after receipt: {formatDuration(bridgePickupMs)}. LM response write after
        pickup: {formatDuration(modelRuntimeMs)}.
      </p>
    </article>
  );
}

function Workspace({ userId, userEmail }: { userId: string; userEmail: string | null | undefined }) {
  const db = usePowerSync();
  const status = useStatus();
  const { data: devices } = useQuery(`SELECT * FROM ${APP_TABLES.devices} ORDER BY last_seen_at DESC`);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const activeDeviceId = selectedDeviceId ?? devices[0]?.id ?? null;
  const activeDevice = devices.find((device) => device.id === activeDeviceId) ?? null;

  const { data: conversations } = useQuery(
    `SELECT * FROM ${APP_TABLES.conversations} WHERE (? IS NULL OR target_device_id = ?) ORDER BY COALESCE(last_message_at, created_at) DESC`,
    [activeDeviceId, activeDeviceId]
  );

  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const activeConversationId = selectedConversationId ?? conversations[0]?.id ?? null;

  const { data: messages } = useQuery<MessageRow>(
    `SELECT * FROM ${APP_TABLES.messages} WHERE (? IS NULL OR conversation_id = ?) ORDER BY created_at ASC`,
    [activeConversationId, activeConversationId]
  );

  const { data: models } = useQuery(
    `SELECT * FROM ${APP_TABLES.deviceModels} WHERE (? IS NULL OR device_id = ?) ORDER BY is_loaded DESC, model_identifier ASC`,
    [activeDeviceId, activeDeviceId]
  );

  const { data: operations } = useQuery<DeviceOperationRow>(
    `SELECT * FROM ${APP_TABLES.deviceOperations} WHERE (? IS NULL OR conversation_id = ?) ORDER BY created_at DESC LIMIT 20`,
    [activeConversationId, activeConversationId]
  );
  const { data: operationEvents } = useQuery<OperationEventJoinRow>(
    `
      SELECT
        e.*,
        o.conversation_id,
        o.type AS operation_type,
        o.status AS operation_status,
        o.created_at AS operation_created_at
      FROM ${APP_TABLES.operationEvents} e
      JOIN ${APP_TABLES.deviceOperations} o ON o.id = e.operation_id
      WHERE (? IS NULL OR o.conversation_id = ?)
      ORDER BY o.created_at DESC, e.created_at ASC
      LIMIT 200
    `,
    [activeConversationId, activeConversationId]
  );

  const [prompt, setPrompt] = useState("");
  const [reasoningMode, setReasoningMode] = useState<ReasoningMode>(readStoredReasoningMode);
  const renderMeasuredOperations = useRef<Set<string>>(new Set());
  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [activeConversationId, conversations]
  );
  const activeDevicePaired = activeDevice?.pairing_status === DEVICE_PAIRING_STATUS.paired;
  const benchmarks = useMemo(
    () => buildOperationBenchmarks(operations, operationEvents),
    [operationEvents, operations]
  );

  useEffect(() => {
    window.localStorage.setItem("synced-lm-studio:reasoning-mode", reasoningMode);
  }, [reasoningMode]);

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

  useEffect(() => {
    const visibleMessageIds = new Set(messages.map((message) => message.id));
    const readyToMeasure = operations
      .filter((operation) => operation.type === DEVICE_OPERATION_TYPE.sendMessage)
      .map((operation) => {
        if (renderMeasuredOperations.current.has(operation.id)) {
          return null;
        }

        const existingRenderEvent = findOperationEvent(
          operationEvents,
          operation.id,
          OPERATION_EVENT_TYPE.benchmarkWebResponseRendered
        );
        if (existingRenderEvent) {
          renderMeasuredOperations.current.add(operation.id);
          return null;
        }

        const assistantMessageId = readAssistantMessageId(operationEvents, operation.id);
        if (!assistantMessageId || !visibleMessageIds.has(assistantMessageId)) {
          return null;
        }

        return {
          operationId: operation.id,
          deviceId: operation.device_id,
          assistantMessageId
        };
      })
      .filter((entry) => entry != null);

    if (readyToMeasure.length === 0) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      void Promise.all(
        readyToMeasure.map(async (entry) => {
          renderMeasuredOperations.current.add(entry.operationId);

          try {
            await db.execute(
              `
                INSERT INTO ${APP_TABLES.operationEvents}
                  (id, operation_id, device_id, event_type, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
              `,
              [
                crypto.randomUUID(),
                entry.operationId,
                entry.deviceId,
                OPERATION_EVENT_TYPE.benchmarkWebResponseRendered,
                JSON.stringify({
                  assistant_message_id: entry.assistantMessageId
                }),
                new Date().toISOString()
              ]
            );
          } catch (error) {
            renderMeasuredOperations.current.delete(entry.operationId);
            console.error("Failed to record web render benchmark", error);
          }
        })
      );
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [db, messages, operationEvents, operations]);

  const approveDevicePairing = async (deviceId: string) => {
    const now = new Date().toISOString();
    await db.execute(
      `
        UPDATE ${APP_TABLES.devices}
        SET pairing_status = ?, pairing_code = ?, paired_at = ?, updated_at = ?
        WHERE id = ?
      `,
      [DEVICE_PAIRING_STATUS.paired, null, now, now, deviceId]
    );
  };

  const resetDevicePairing = async (deviceId: string) => {
    const now = new Date().toISOString();
    await db.execute(
      `
        UPDATE ${APP_TABLES.devices}
        SET pairing_status = ?, pairing_code = ?, paired_at = ?, updated_at = ?
        WHERE id = ?
      `,
      [DEVICE_PAIRING_STATUS.pending, nextPairingCode(), null, now, deviceId]
    );
  };

  const sendPrompt = async () => {
    if (!activeDeviceId || !activeDevicePaired || !prompt.trim()) {
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
            reasoning: reasoningMode,
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

      await tx.execute(
        `
          INSERT INTO ${APP_TABLES.operationEvents}
            (id, operation_id, device_id, event_type, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          crypto.randomUUID(),
          operationId,
          activeDeviceId,
          OPERATION_EVENT_TYPE.benchmarkWebSubmit,
          JSON.stringify({
            user_message_id: messageId
          }),
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
          <p className="lede">Signed in as {userEmail ?? userId}</p>
          <button onClick={queueRefreshModels} disabled={!activeDeviceId}>
            Refresh models
          </button>
          <button
            className="ghost-button"
            onClick={() => {
              void supabase.auth.signOut();
            }}
          >
            Sign out
          </button>
          <div className="device-list">
            {devices.map((device) => (
              <button
                key={device.id}
                className={device.id === activeDeviceId ? "list-row active" : "list-row"}
                onClick={() => setSelectedDeviceId(device.id)}
              >
                <span>{device.display_name}</span>
                <small>
                  {device.status} · {device.pairing_status ?? DEVICE_PAIRING_STATUS.pending}
                </small>
              </button>
            ))}
          </div>
          {activeDevice && activeDevice.pairing_status !== DEVICE_PAIRING_STATUS.paired ? (
            <div className="pairing-card">
              <p className="kicker">Pairing</p>
              <h3>{activeDevice.display_name}</h3>
              <p>Approve this bridge before it can execute queued operations.</p>
              <p className="pairing-code">{activeDevice.pairing_code ?? "pending"}</p>
              <button onClick={() => approveDevicePairing(activeDevice.id)}>Pair device</button>
              <button className="ghost-button" onClick={() => resetDevicePairing(activeDevice.id)}>
                Reset code
              </button>
            </div>
          ) : null}
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
            {messages.map((message) => {
              const { text } = parseMessageContent(message.content_json);

              return (
                <article
                  className={message.role === "assistant" ? "message assistant" : "message user"}
                  key={message.id}
                >
                  <p className="message-role">{message.role}</p>
                  {message.role === "assistant" ? (
                    <AssistantMessage contentJson={message.content_json} />
                  ) : (
                    <p className="message-body message-body-plain">{text}</p>
                  )}
                </article>
              );
            })}
          </div>
          <div className="composer">
            <div className="composer-shell">
              <textarea
                placeholder="Send a prompt to the selected LM Studio bridge…"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <div className="composer-footer">
                <div className="composer-actions">
                  <label className="composer-select">
                    <span>Think</span>
                    <select
                      value={reasoningMode}
                      onChange={(event) => setReasoningMode(event.target.value as ReasoningMode)}
                    >
                      {REASONING_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <button
                  onClick={sendPrompt}
                  disabled={!activeDeviceId || !activeDevicePaired || !prompt.trim()}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="operations-panel">
          <header className="panel-header">
            <div>
              <p className="kicker">Round Trip</p>
              <h2>Latency breakdown</h2>
            </div>
          </header>
          <div className="operation-list">
            {benchmarks.length === 0 ? (
              <p className="lede">Send a message to capture web, bridge, and render timings.</p>
            ) : null}
            {benchmarks.map((benchmark) => (
              <OperationBenchmarkCard key={benchmark.operationId} benchmark={benchmark} />
            ))}
          </div>
          <div className="operation-list operation-status-list">
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
      setDatabaseError(null);
      return;
    }

    if (!webConfig.powersyncUrl) {
      setDatabase(null);
      setDatabaseError(null);
      return;
    }

    void createWebDatabase(supabase, webConfig.powersyncUrl)
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
    return <AuthCard />;
  }

  if (!webConfig.powersyncUrl) {
    return (
      <SetupCard
        title="PowerSync isn't configured yet"
        description="Set VITE_POWERSYNC_URL in your Vercel project after the PowerSync instance is ready. Supabase auth is live, but the synced workspace needs a PowerSync endpoint."
      />
    );
  }

  if (databaseError) {
    return (
      <SetupCard
        title="Couldn't initialize the synced workspace"
        description="The app built successfully, but PowerSync could not be initialized with the current environment."
        detail={databaseError}
      />
    );
  }

  if (!database) {
    return <div className="auth-shell">Connecting PowerSync…</div>;
  }

  return (
    <PowerSyncContext.Provider value={database}>
      <Workspace userId={auth.session.user.id} userEmail={auth.session.user.email} />
    </PowerSyncContext.Provider>
  );
}
