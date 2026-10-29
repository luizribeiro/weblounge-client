import { createSignal, onCleanup, onMount } from "solid-js";
import { commandHelp } from "./actions/command-help";
import { consumeDebugPassword } from "./debug-irc-config";
import { createEngineClient } from "./engine/createEngineClient";
import type { EngineClient } from "./engine/EngineClient";
import {
  EngineCommandError,
  IncompatibleBuildError,
} from "./engine/EngineClient";
import type {
  BufferProjection,
  CommandSpec,
  CompletionResult,
  EngineClientMessage,
  MembershipProjection,
  MessageProjection,
  NetworkProjection,
} from "./engine/protocol";
import { t } from "./features/composer/strings";
import type { MemberWindow } from "./features/members/MemberPanel";
import type { HostedSession } from "./hosted/HostedSession";
import { HostedStatus } from "./hosted/HostedStatus";
import { ResponsiveShell } from "./shells/ResponsiveShell";
import {
  contextMenuRegistry,
  installContextMenuHandler,
} from "./ui/context-menu";

const reloadMarker = "weblounge-build-reload";

interface AppProps {
  engineClient?: EngineClient;
  hostedSession?: HostedSession;
  onHostedAuthorizationRequired?: (reason: "expired" | "revoked") => void;
}

export function App(props: AppProps) {
  const clientId = crypto.randomUUID();
  const [engineStatus, setEngineStatus] = createSignal("Starting engine…");
  const [engineNotice, setEngineNotice] = createSignal<string>();
  const [hostedError, setHostedError] = createSignal<string>();
  const [composerNotice, setComposerNotice] = createSignal<string>();
  const [commandSpecs, setCommandSpecs] = createSignal<CommandSpec[]>();
  const [completion, setCompletion] = createSignal<CompletionResult>();
  const [focusRequest, setFocusRequest] = createSignal<{ bufferId: number }>();
  const [networks, setNetworks] = createSignal<NetworkProjection[]>([]);
  const [buffers, setBuffers] = createSignal<BufferProjection[]>([]);
  const [messages, setMessages] = createSignal<
    ReadonlyMap<number, readonly MessageProjection[]>
  >(new Map());
  const [memberships, setMemberships] = createSignal<
    ReadonlyMap<number, readonly MembershipProjection[]>
  >(new Map());
  const [memberWindows, setMemberWindows] = createSignal<
    ReadonlyMap<string, MemberWindow>
  >(new Map());
  let client: EngineClient | undefined;
  let appRoot: HTMLElement | undefined;
  let latestCompletionRequest: string | undefined;
  let cancelTokenExpiry = () => {};
  let restartingHostedAuthorization = false;

  onMount(() => {
    const removeContextMenuHandler = installContextMenuHandler(document);
    const unregisterContextSurface =
      appRoot === undefined
        ? () => {}
        : contextMenuRegistry.register(appRoot, {
            id: "app-root",
            kind: "chrome",
          });
    const mountedClient = props.engineClient ?? createEngineClient();
    client = mountedClient;
    const unsubscribe = mountedClient.subscribe((message) => {
      if (message.type === "diagnostic") {
        setEngineStatus(`Engine ready: ${message.message}`);
      }
      if (message.type === "notice") {
        if (message.message_key === "engine.hosted_auth_failed") {
          void restartHostedAuthorization("revoked");
          return;
        }
        const notice = t(message.message_key);
        setEngineNotice(notice);
        if (message.message_key === "engine.connection_failed") {
          setComposerNotice(notice);
          if (props.hostedSession !== undefined) setHostedError(notice);
        }
      }
      if (message.type === "message_failed") {
        setComposerNotice(t(message.message_key));
      }
      if (message.type === "command_specs_changed") {
        setCommandSpecs(message.specs);
      }
      if (message.type === "command_help_requested") {
        setComposerNotice(commandHelp(commandSpecs() ?? [], message.command));
      }
      if (message.type === "completion_result") {
        if (message.command_id === latestCompletionRequest) {
          setCompletion(message);
        }
      }
      if (message.type === "focus_buffer_requested") {
        setFocusRequest({ bufferId: message.buffer_id });
      }
      if (
        message.type === "network_state_changed" &&
        message.network.state === "online"
      ) {
        setHostedError(undefined);
      }
      if (message.type === "members_changed") {
        const viewId = message.view_id;
        const version = message.version;
        const windowSize = message.window_size;
        if (
          viewId !== undefined &&
          version !== undefined &&
          windowSize !== undefined
        )
          setMemberWindows((current) =>
            new Map(current).set(viewId, {
              ...message,
              view_id: viewId,
              version,
              window_size: windowSize,
            }),
          );
      }
      applyDebugEvent(
        message,
        setNetworks,
        setBuffers,
        setMessages,
        setMemberships,
      );
    });
    const updateVisibility = () => {
      mountedClient.setVisibility(document.hidden ? "hidden" : "visible");
    };
    document.addEventListener("visibilitychange", updateVisibility);
    updateVisibility();

    const debugPassword =
      __DEBUG_IRC_CONFIG__ === null
        ? null
        : consumeDebugPassword(new URL(window.location.href), (path) =>
            window.history.replaceState(window.history.state, "", path),
          );
    void startEngine(
      mountedClient,
      setEngineStatus,
      setHostedError,
      debugPassword,
      props.hostedSession,
      clientId,
    ).then(() => {
      if (props.hostedSession === undefined) return;
      cancelTokenExpiry = scheduleExpiry(
        props.hostedSession.token.expiresAt,
        () => void restartHostedAuthorization("expired"),
      );
    });
    onCleanup(() => {
      cancelTokenExpiry();
      unregisterContextSurface();
      removeContextMenuHandler();
      document.removeEventListener("visibilitychange", updateVisibility);
      unsubscribe();
      void mountedClient.close();
    });

    async function restartHostedAuthorization(
      reason: "expired" | "revoked",
    ): Promise<void> {
      if (restartingHostedAuthorization) return;
      restartingHostedAuthorization = true;
      cancelTokenExpiry();
      setHostedError("Your session expired. Signing in again…");
      const network = networks()[0];
      if (network !== undefined) {
        await mountedClient
          .send({
            id: crypto.randomUUID(),
            request: {
              type: "expire_hosted_authentication",
              network_id: network.id,
            },
          })
          .catch(() => undefined);
      }
      props.onHostedAuthorizationRequired?.(reason);
    }
  });

  const hostedReady = () =>
    props.hostedSession === undefined ||
    networks().some((network) => network.state === "online");

  return (
    <div
      data-app-root="true"
      ref={(element) => {
        appRoot = element;
      }}
    >
      <p class="visually-hidden" role="status">
        {engineStatus()}
      </p>
      {engineNotice() !== undefined && (
        <p class="visually-hidden" role="note">
          {engineNotice()}
        </p>
      )}
      {!hostedReady() ? (
        <HostedStatus
          message={hostedError() ?? "Signing in…"}
          error={hostedError() !== undefined}
        />
      ) : (
        <ResponsiveShell
          memberViewScope={clientId}
          networks={networks()}
          buffers={buffers()}
          commandSpecs={commandSpecs()}
          composerNotice={composerNotice()}
          completion={completion()}
          focusRequest={focusRequest()}
          messages={messages()}
          memberships={memberships()}
          memberWindows={memberWindows()}
          onMarkRead={(bufferId, through) => {
            if (client === undefined) return;
            void client.send({
              id: crypto.randomUUID(),
              request: { type: "mark_read", buffer_id: bufferId, through },
            });
          }}
          onLoadHistory={(bufferId) => {
            if (client === undefined) return;
            void client.send({
              id: crypto.randomUUID(),
              request: { type: "load_history", buffer_id: bufferId },
            });
          }}
          onSend={(bufferId, text) => {
            if (client === undefined) return Promise.resolve(false);
            setComposerNotice(undefined);
            return client
              .send({
                id: crypto.randomUUID(),
                request: {
                  type: "submit_input",
                  buffer_id: bufferId,
                  input: text,
                },
              })
              .then(() => true)
              .catch((error: unknown) => {
                setComposerNotice(
                  error instanceof EngineCommandError
                    ? t(error.messageKey, { input: text })
                    : t("engine.command_failed"),
                );
                return false;
              });
          }}
          onRequestCompletion={(bufferId, input, cursor, explicit) => {
            if (client === undefined) return;
            const id = crypto.randomUUID();
            latestCompletionRequest = id;
            void client
              .send({
                id,
                request: {
                  type: "complete_input",
                  buffer_id: bufferId,
                  input,
                  cursor,
                  explicit,
                },
              })
              .then(() => {
                if (
                  latestCompletionRequest === id &&
                  completion()?.command_id !== id
                ) {
                  setCompletion(undefined);
                }
              })
              .catch(() => {
                if (latestCompletionRequest === id) setCompletion(undefined);
              });
          }}
          onRequestMembers={(viewId, bufferId, offset, filter = "") => {
            if (client === undefined) return;
            void client.send({
              id: crypto.randomUUID(),
              request: {
                type: "request_members",
                buffer_id: bufferId,
                view_id: viewId,
                offset,
                filter,
              },
            });
          }}
          onOpenDirect={(networkId, nick) => {
            if (client === undefined) return;
            void client.send({
              id: crypto.randomUUID(),
              request: { type: "open_direct", network_id: networkId, nick },
            });
          }}
        />
      )}
    </div>
  );
}

async function startEngine(
  client: EngineClient,
  setStatus: (status: string) => void,
  setHostedError: (message: string) => void,
  debugPassword: string | null,
  hostedSession: HostedSession | undefined,
  clientId: string,
): Promise<void> {
  try {
    await client.start({
      build_id: __BUILD_ID__,
      client_id: clientId,
      last_revision: null,
      shell: "web",
    });
    sessionStorage.removeItem(reloadMarker);
    await client.send({
      id: crypto.randomUUID(),
      request: {
        type: "diagnostic",
        message: "wasm worker round trip complete",
      },
    });
    if (hostedSession !== undefined) {
      await client.send({
        id: crypto.randomUUID(),
        request: {
          type: "connect_hosted",
          label: hostedSession.network.name,
          endpoint: hostedSession.network.endpoint,
          nickname: "*",
          oauth_token: hostedSession.token.take(),
          autojoin: hostedSession.network.autojoin,
        },
      });
    } else if (__DEBUG_IRC_CONFIG__ !== null && debugPassword !== null) {
      await client.send({
        id: crypto.randomUUID(),
        request: {
          type: "connect",
          label: "Local Ergo",
          endpoint: __DEBUG_IRC_CONFIG__.endpoint,
          nickname: __DEBUG_IRC_CONFIG__.nickname,
          sasl: {
            account: __DEBUG_IRC_CONFIG__.account,
            password: debugPassword,
          },
          autojoin: [__DEBUG_IRC_CONFIG__.channel],
          allow_insecure: __DEBUG_IRC_CONFIG__.allowInsecure,
        },
      });
    }
  } catch (error: unknown) {
    if (error instanceof IncompatibleBuildError) {
      recoverFromBuildMismatch(setStatus);
      return;
    }
    setStatus("Engine failed to start");
    if (hostedSession !== undefined) {
      setHostedError("Couldn't start the chat. Reload the app to try again.");
    }
  }
}

function scheduleExpiry(expiresAt: number, expire: () => void): () => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    timeout = setTimeout(arm, Math.min(remaining, 2_147_000_000));
  };
  arm();
  return () => {
    if (timeout !== undefined) clearTimeout(timeout);
  };
}

function applyDebugEvent(
  message: EngineClientMessage,
  setNetworks: (
    update: (current: NetworkProjection[]) => NetworkProjection[],
  ) => void,
  setBuffers: (
    update: (current: BufferProjection[]) => BufferProjection[],
  ) => void,
  setMessages: (
    update: (
      current: ReadonlyMap<number, readonly MessageProjection[]>,
    ) => ReadonlyMap<number, readonly MessageProjection[]>,
  ) => void,
  setMemberships: (
    update: (
      current: ReadonlyMap<number, readonly MembershipProjection[]>,
    ) => ReadonlyMap<number, readonly MembershipProjection[]>,
  ) => void,
): void {
  if (message.type === "network_state_changed") {
    setNetworks((current) => upsert(current, message.network));
  } else if (message.type === "buffers_changed") {
    setBuffers((current) => [
      ...current.filter((buffer) => buffer.network_id !== message.network_id),
      ...message.buffers,
    ]);
  } else if (message.type === "buffer_added") {
    setBuffers((current) => upsert(current, message.buffer));
  } else if (message.type === "buffer_updated") {
    setBuffers((current) => upsert(current, message.buffer));
  } else if (message.type === "unread_changed") {
    setBuffers((current) =>
      current.map((buffer) =>
        buffer.id === message.buffer_id
          ? { ...buffer, unread: message.unread, mentions: message.mentions }
          : buffer,
      ),
    );
  } else if (message.type === "read_marker_moved") {
    setBuffers((current) =>
      current.map((buffer) =>
        buffer.id === message.buffer_id
          ? { ...buffer, read_through: message.through }
          : buffer,
      ),
    );
  } else if (message.type === "messages_appended") {
    setMessages((current) => {
      const next = new Map(current);
      next.set(message.buffer_id, [
        ...(current.get(message.buffer_id) ?? []),
        ...message.messages,
      ]);
      return next;
    });
  } else if (message.type === "messages_prepended") {
    setMessages((current) => {
      const next = new Map(current);
      const prependedIds = new Set(message.messages.map((item) => item.id));
      next.set(message.buffer_id, [
        ...message.messages,
        ...(current.get(message.buffer_id) ?? []).filter(
          (item) => !prependedIds.has(item.id),
        ),
      ]);
      return next;
    });
  } else if (message.type === "membership_changed") {
    setMemberships((current) => {
      const next = new Map(current);
      const existing = current.get(message.buffer_id) ?? [];
      const found = existing.some((item) => item.id === message.membership.id);
      next.set(
        message.buffer_id,
        found
          ? existing.map((item) =>
              item.id === message.membership.id ? message.membership : item,
            )
          : [...existing, message.membership],
      );
      return next;
    });
  } else if (message.type === "message_confirmed") {
    setMessages((current) => {
      const next = new Map(current);
      const messages = current.get(message.buffer_id) ?? [];
      const hasPending = messages.some(
        (item) => item.local_send_id === message.local_send_id,
      );
      next.set(
        message.buffer_id,
        hasPending
          ? messages.map((item) =>
              item.local_send_id === message.local_send_id
                ? message.message
                : item,
            )
          : [...messages, message.message],
      );
      return next;
    });
  } else if (message.type === "message_failed") {
    setMessages((current) => {
      const next = new Map(current);
      next.set(
        message.buffer_id,
        (current.get(message.buffer_id) ?? []).map((item) =>
          item.local_send_id === message.local_send_id
            ? { ...item, delivery: "failed" }
            : item,
        ),
      );
      return next;
    });
  }
}

function upsert<T extends { id: number }>(current: T[], value: T): T[] {
  const existing = current.findIndex((item) => item.id === value.id);
  if (existing === -1) return [...current, value];
  return current.map((item, index) => (index === existing ? value : item));
}

export function recoverFromBuildMismatch(
  setStatus: (status: string) => void,
  storage: Pick<Storage, "getItem" | "setItem"> = sessionStorage,
  reload: () => void = () => location.reload(),
): void {
  if (storage.getItem(reloadMarker) === __BUILD_ID__) {
    setStatus("Engine update failed; reload site data to recover");
    return;
  }

  storage.setItem(reloadMarker, __BUILD_ID__);
  reload();
}
