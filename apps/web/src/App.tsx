import { useEffect, useMemo, useRef, useState, startTransition } from "react";
import {
  PowerSyncContext,
  usePowerSync,
  useQuery,
  useStatus
} from "@powersync/react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
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
import { sharedSupabase, supabase } from "./supabase";

type AuthState = {
  session: Session | null;
  loading: boolean;
  error: string | null;
};

type AppMode =
  | {
      kind: "workspace";
    }
  | {
      kind: "share";
      shareToken: string;
    };

type ShareFeedback =
  | {
      kind: "status";
      message: string;
    }
  | {
      kind: "link";
      message: string;
      href: string;
    };

type ConversationRow = AppDatabase["conversations"];
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

const SHARED_CONVERSATION_STREAM = "shared_conversation";

function readAppMode(): AppMode {
  if (typeof window === "undefined") {
    return { kind: "workspace" };
  }

  const shareToken = new URLSearchParams(window.location.search).get("share")?.trim();
  if (shareToken) {
    return {
      kind: "share",
      shareToken
    };
  }

  return { kind: "workspace" };
}

function createShareToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

function createShareLink(shareToken: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("share", shareToken);
  url.hash = "";
  return url.toString();
}

function shareDatabaseFilename(shareToken: string) {
  const safeToken = shareToken.replace(/[^a-z0-9_-]/gi, "").slice(0, 8) || "shared";
  return `synced-lm-studio-share-v2-${safeToken}.db`;
}

function useSupabaseSession(supabaseClient: SupabaseClient, allowAnonymous = false) {
  const [state, setState] = useState<AuthState>({
    session: null,
    loading: true,
    error: null
  });

  useEffect(() => {
    let mounted = true;

    const initialize = async () => {
      const { data, error } = await supabaseClient.auth.getSession();
      if (!mounted) {
        return;
      }

      if (error) {
        setState({
          session: null,
          loading: false,
          error: error.message
        });
        return;
      }

      if (!data.session && allowAnonymous) {
        const { data: anonymousData, error: anonymousError } =
          await supabaseClient.auth.signInAnonymously();
        if (!mounted) {
          return;
        }

        setState({
          session: anonymousData.session ?? null,
          loading: false,
          error: anonymousError?.message ?? null
        });
        return;
      }

      setState({
        session: data.session,
        loading: false,
        error: null
      });
    };

    const { data: subscription } = supabaseClient.auth.onAuthStateChange((_event, session) => {
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
  }, [allowAnonymous, supabaseClient]);

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
  detail,
  actionLabel,
  onAction
}: {
  title: string;
  description: string;
  detail?: string | null;
  actionLabel?: string;
  onAction?: (() => void) | null;
}) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <p className="kicker">PowerSync</p>
        <h1>{title}</h1>
        <p className="lede">{description}</p>
        {detail ? <p className="error-banner">{detail}</p> : null}
        {actionLabel && onAction ? (
          <button type="button" className="ghost-button" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
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

function SharedConversation({ shareToken }: { shareToken: string }) {
  const status = useStatus();
  const [timedOut, setTimedOut] = useState(false);
  const sharedStreamOptions = useMemo(
    () => ({
      streams: [
        {
          name: SHARED_CONVERSATION_STREAM,
          parameters: {
            share_token: shareToken
          },
          waitForStream: true,
          priority: 1 as const,
          ttl: 0
        }
      ]
    }),
    [shareToken]
  );

  useEffect(() => {
    setTimedOut(false);
    const timeoutId = window.setTimeout(() => {
      setTimedOut(true);
    }, 8_000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [shareToken]);

  const {
    data: conversations,
    isLoading: conversationsLoading,
    error: conversationError
  } = useQuery<ConversationRow>(
    `SELECT * FROM ${APP_TABLES.conversations} WHERE share_token = ? LIMIT 1`,
    [shareToken],
    sharedStreamOptions
  );
  const { data: messages, isLoading: messagesLoading, error: messagesError } = useQuery<MessageRow>(
    `
      SELECT m.*
      FROM ${APP_TABLES.messages} m
      JOIN ${APP_TABLES.conversations} c ON c.id = m.conversation_id
      WHERE c.share_token = ?
      ORDER BY m.created_at ASC
    `,
    [shareToken],
    sharedStreamOptions
  );

  const conversation = conversations[0] ?? null;
  const detail =
    conversationError instanceof Error
      ? conversationError.message
      : messagesError instanceof Error
        ? messagesError.message
        : timedOut
          ? `Connection state: ${status.connected ? "connected" : "reconnecting"}.`
          : null;

  if (conversationError || messagesError) {
    return (
      <SetupCard
        title="Shared chat failed to load"
        description="The browser could not finish the first sync for this shared conversation."
        detail={detail}
      />
    );
  }

  if (conversationsLoading || messagesLoading) {
    if (timedOut) {
      return (
        <SetupCard
          title="Shared chat is taking too long"
          description="The browser is still waiting for the first shared-conversation sync to finish."
          detail={detail}
        />
      );
    }

    return <div className="auth-shell">Loading shared conversation…</div>;
  }

  if (!conversation) {
    return (
      <SetupCard
        title="Shared chat unavailable"
        description="This link no longer maps to an active shared conversation."
        detail="The owner may have revoked the link, or the token is invalid."
      />
    );
  }

  return (
    <main className="shared-shell">
      <section className="shared-header auth-card">
        <div>
          <p className="kicker">Shared chat</p>
          <h1>{conversation.title}</h1>
        </div>
        <p className="status-pill">
          {status.connected ? "PowerSync connected" : "PowerSync reconnecting"}
        </p>
        <p className="lede">
          Live, read-only transcript synced through the conversation&apos;s dedicated PowerSync
          stream.
        </p>
      </section>

      <section className="chat-panel shared-chat-panel">
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
          {messages.length === 0 ? (
            <p className="lede">This shared conversation does not have any synced messages yet.</p>
          ) : null}
        </div>
      </section>
    </main>
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
  const [shareFeedback, setShareFeedback] = useState<ShareFeedback | null>(null);
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
    if (!shareFeedback || shareFeedback.kind === "link") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setShareFeedback((current) => (current?.kind === "status" ? null : current));
    }, 4_000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [shareFeedback]);

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

  const copyConversationShareLink = async () => {
    if (!selectedConversation) {
      return;
    }

    const shareToken = selectedConversation.share_token ?? createShareToken();
    if (!selectedConversation.share_token) {
      const now = new Date().toISOString();
      await db.execute(
        `
          UPDATE ${APP_TABLES.conversations}
          SET share_token = ?, shared_at = ?, updated_at = ?
          WHERE id = ?
        `,
        [shareToken, now, now, selectedConversation.id]
      );
    }

    const shareLink = createShareLink(shareToken);

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API is unavailable");
      }

      await navigator.clipboard.writeText(shareLink);
      setShareFeedback({
        kind: "status",
        message: "Share link copied to the clipboard."
      });
    } catch {
      setShareFeedback({
        kind: "link",
        message: "Copy this share link:",
        href: shareLink
      });
    }
  };

  const revokeConversationShareLink = async () => {
    if (!selectedConversation?.share_token) {
      return;
    }

    const now = new Date().toISOString();
    await db.execute(
      `
        UPDATE ${APP_TABLES.conversations}
        SET share_token = ?, shared_at = ?, updated_at = ?
        WHERE id = ?
      `,
      [null, null, now, selectedConversation.id]
    );
    setShareFeedback({
      kind: "status",
      message: "Share link revoked."
    });
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
            <div className="panel-actions">
              {selectedConversation?.share_token ? <p className="status-pill">Shared</p> : null}
              <button
                className="ghost-button"
                onClick={() => {
                  void copyConversationShareLink();
                }}
                disabled={!selectedConversation}
              >
                {selectedConversation?.share_token ? "Copy share link" : "Share chat"}
              </button>
              {selectedConversation?.share_token ? (
                <button
                  className="ghost-button"
                  onClick={() => {
                    void revokeConversationShareLink();
                  }}
                >
                  Revoke link
                </button>
              ) : null}
            </div>
          </header>
          {shareFeedback ? (
            <p className="share-feedback lede">
              {shareFeedback.message}{" "}
              {shareFeedback.kind === "link" ? (
                <a href={shareFeedback.href} target="_blank" rel="noreferrer">
                  {shareFeedback.href}
                </a>
              ) : null}
            </p>
          ) : null}
          <div className="conversation-list">
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                className={
                  conversation.id === activeConversationId ? "conversation-row active" : "conversation-row"
                }
                onClick={() => setSelectedConversationId(conversation.id)}
              >
                <span>
                  {conversation.title}
                  {conversation.share_token ? " · Shared" : ""}
                </span>
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
  const mode = useMemo(readAppMode, []);
  const supabaseClient = mode.kind === "share" ? sharedSupabase : supabase;
  const auth = useSupabaseSession(supabaseClient, mode.kind === "share");
  const [database, setDatabase] = useState<Awaited<ReturnType<typeof createWebDatabase>> | null>(null);
  const [databaseError, setDatabaseError] = useState<string | null>(null);
  const databaseRef = useRef<Awaited<ReturnType<typeof createWebDatabase>> | null>(null);
  const initSequenceRef = useRef(0);
  const databaseKey =
    auth.session == null
      ? null
      : mode.kind === "share"
        ? `share:${mode.shareToken}`
        : `workspace:${auth.session.user.id}`;

  const closeDatabase = async (db: Awaited<ReturnType<typeof createWebDatabase>> | null) => {
    if (!db) {
      return;
    }

    try {
      await db.close({ disconnect: true });
    } catch (error) {
      console.warn("Failed to close PowerSync database cleanly", error);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const initSequence = ++initSequenceRef.current;

    const replaceDatabase = async () => {
      const previousDatabase = databaseRef.current;
      databaseRef.current = null;
      setDatabase(null);

      if (!databaseKey || !webConfig.powersyncUrl) {
        setDatabaseError(null);
        await closeDatabase(previousDatabase);
        return;
      }

      setDatabaseError(null);
      await closeDatabase(previousDatabase);

      const nextDatabase = await createWebDatabase(supabaseClient, webConfig.powersyncUrl, {
        allowAnonymous: mode.kind === "share",
        dbFilename:
          mode.kind === "share" ? shareDatabaseFilename(mode.shareToken) : "synced-lm-studio.db",
        flags:
          mode.kind === "share"
            ? {
                enableMultiTabs: false,
                useWebWorker: false
              }
            : undefined,
        readOnly: mode.kind === "share"
      });

      if (cancelled || initSequence !== initSequenceRef.current) {
        await closeDatabase(nextDatabase);
        return;
      }

      databaseRef.current = nextDatabase;
      setDatabase(nextDatabase);
      setDatabaseError(null);
    };

    void replaceDatabase().catch(async (error) => {
      if (cancelled || initSequence !== initSequenceRef.current) {
        return;
      }

      databaseRef.current = null;
      setDatabase(null);
      setDatabaseError(error instanceof Error ? error.message : "Failed to initialize PowerSync");
    });

    return () => {
      cancelled = true;
    };
  }, [databaseKey, mode, supabaseClient]);

  useEffect(() => {
    return () => {
      const activeDatabase = databaseRef.current;
      databaseRef.current = null;
      void closeDatabase(activeDatabase);
    };
  }, []);

  if (auth.loading) {
    return (
      <div className="auth-shell">
        {mode.kind === "share" ? "Preparing shared conversation…" : "Loading authentication…"}
      </div>
    );
  }

  if (auth.error) {
    return (
      <SetupCard
        title={mode.kind === "share" ? "Anonymous auth is unavailable" : "Authentication failed"}
        description={
          mode.kind === "share"
            ? "This share link relies on Supabase anonymous sign-in so the page can fetch a scoped PowerSync token."
            : "The web client could not restore the current Supabase session."
        }
        detail={auth.error}
        actionLabel={mode.kind === "workspace" ? "Sign out" : undefined}
        onAction={
          mode.kind === "workspace"
            ? () => {
                void supabase.auth.signOut();
              }
            : undefined
        }
      />
    );
  }

  if (!auth.session) {
    if (mode.kind === "share") {
      return (
        <SetupCard
          title="Shared chat unavailable"
          description="The client could not establish the anonymous session required for this share link."
        />
      );
    }

    return <AuthCard />;
  }

  if (!webConfig.powersyncUrl) {
    return (
      <SetupCard
        title="PowerSync isn't configured yet"
        description="Set VITE_POWERSYNC_URL in your Vercel project after the PowerSync instance is ready. Supabase auth is live, but the synced workspace needs a PowerSync endpoint."
        actionLabel={mode.kind === "workspace" ? "Sign out" : undefined}
        onAction={
          mode.kind === "workspace"
            ? () => {
                void supabase.auth.signOut();
              }
            : undefined
        }
      />
    );
  }

  if (databaseError) {
    return (
      <SetupCard
        title={mode.kind === "share" ? "Couldn't load the shared chat" : "Couldn't initialize the synced workspace"}
        description={
          mode.kind === "share"
            ? "The share link resolved, but PowerSync could not initialize a scoped read-only replica for it."
            : "The app built successfully, but PowerSync could not be initialized with the current environment."
        }
        detail={databaseError}
        actionLabel={mode.kind === "workspace" ? "Sign out" : undefined}
        onAction={
          mode.kind === "workspace"
            ? () => {
                void supabase.auth.signOut();
              }
            : undefined
        }
      />
    );
  }

  if (!database) {
    return (
      <div className="auth-shell">
        {mode.kind === "share" ? "Connecting shared PowerSync replica…" : "Connecting PowerSync…"}
      </div>
    );
  }

  return (
    <PowerSyncContext.Provider value={database}>
      {mode.kind === "share" ? (
        <SharedConversation shareToken={mode.shareToken} />
      ) : (
        <Workspace userId={auth.session.user.id} userEmail={auth.session.user.email} />
      )}
    </PowerSyncContext.Provider>
  );
}
