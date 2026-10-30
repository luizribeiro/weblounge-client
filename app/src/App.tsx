import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  type ActionId,
  ActionRegistry,
  isActionId,
} from "./actions/action-registry";
import { commandHelp } from "./actions/command-help";
import { consumeDebugPassword } from "./debug-irc-config";
import {
  connectionFailureMessage,
  connectionStateKind,
} from "./engine/connection-state";
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
import {
  isMessageKey,
  type MessageKey,
  type MessageValues,
  t,
} from "./features/composer/strings";
import type { MemberWindow } from "./features/members/MemberPanel";
import type { HostedSession } from "./hosted/HostedSession";
import { HostedStatus } from "./hosted/HostedStatus";
import { bufferPath } from "./navigation/buffer-route";
import {
  initialDestination,
  readLastViewedPath,
  writeLastViewedPath,
} from "./navigation/initial-buffer";
import { ResponsiveShell } from "./shells/ResponsiveShell";
import {
  contextMenuRegistry,
  installContextMenuHandler,
} from "./ui/context-menu";
import { createNotifier } from "./ui/notices";
import { Toast } from "./ui/Toast";

const reloadMarker = "weblounge-build-reload";

interface AppProps {
  beforeReveal?: () => Promise<void>;
  engineClient?: EngineClient;
  hostedSession?: HostedSession;
  onReady?: () => void;
  onHostedAuthorizationRequired?: (
    reason: "expired" | "revoked" | "worker_restarted",
  ) => void;
  onRetryStartup?: (() => void) | undefined;
}

export function App(props: AppProps) {
  const clientId = crypto.randomUUID();
  const [engineStatus, setEngineStatus] = createSignal("Starting engine…");
  const notifier = createNotifier();
  const [hostedError, setHostedError] = createSignal<string>();
  const [shellReady, setShellReady] = createSignal(
    props.hostedSession === undefined,
  );
  const [startupError, setStartupError] = createSignal<string>();
  const [engineReady, setEngineReady] = createSignal(false);
  const [startupRevealed, setStartupRevealed] = createSignal(false);
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
  const [loadedNetworkIds, setLoadedNetworkIds] = createSignal<
    ReadonlySet<number>
  >(new Set());
  const [initialBufferId, setInitialBufferId] = createSignal<number>();
  let client: EngineClient | undefined;
  let appRoot: HTMLElement | undefined;
  let latestCompletionRequest: string | undefined;
  let cancelTokenExpiry = () => {};
  let restartingHostedAuthorization = false;
  let engineInstance: string | undefined;
  let disposed = false;
  let revealingStartup = false;
  let initialNavigationResolved = false;
  const storedNavigationPath = readLastViewedPath();
  const noticeActions = new ActionRegistry(
    {
      "buffer.open-direct": (context) => {
        if (
          client === undefined ||
          context.targetNetworkId === undefined ||
          context.targetNick === undefined
        ) {
          return;
        }
        void client.send({
          id: crypto.randomUUID(),
          request: {
            type: "open_direct",
            network_id: context.targetNetworkId,
            nick: context.targetNick,
          },
        });
      },
    },
    "other",
  );

  createEffect(() => {
    if (
      !engineReady() ||
      (startupError() === undefined &&
        !shellReady() &&
        hostedError() === undefined)
    ) {
      return;
    }
    void revealStartup();
  });

  createEffect(() => {
    if (initialNavigationResolved) return;
    const currentBuffers = buffers();
    const destination = initialDestination(
      window.location.pathname,
      storedNavigationPath,
      networks(),
      currentBuffers,
      loadedNetworkIds(),
    );
    if (destination === undefined) return;
    initialNavigationResolved = true;
    if (destination.kind === "buffer") setInitialBufferId(destination.bufferId);
  });

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
    const debugPassword =
      __DEBUG_IRC_CONFIG__ === null
        ? null
        : consumeDebugPassword(new URL(window.location.href), (path) =>
            window.history.replaceState(window.history.state, "", path),
          );
    const unsubscribe = mountedClient.subscribe((message) => {
      if (message.type === "ready") {
        const restarted =
          engineInstance !== undefined &&
          engineInstance !== message.engine_instance;
        engineInstance = message.engine_instance;
        if (restarted) {
          if (props.hostedSession !== undefined) {
            void restartHostedAuthorization("worker_restarted");
          } else if (debugPassword !== null) {
            void connectDebugNetwork(mountedClient, debugPassword);
          }
        }
      }
      if (message.type === "diagnostic") {
        setEngineStatus(`Engine ready: ${message.message}`);
      }
      if (message.type === "notice") {
        if (isMessageKey(message.key)) {
          const action = noticeAction(message.action);
          notifier.notify({
            message: {
              key: message.key,
              values: noticeValues(message.values),
            },
            tone: message.tone,
            ...(action === undefined ? {} : { action }),
          });
        }
        if (message.key === "engine.hosted_auth_failed") {
          void restartHostedAuthorization("revoked");
          return;
        }
        const notice = t(message.key, message.values);
        if (message.key === "engine.connection_failed") {
          setComposerNotice(notice);
          if (props.hostedSession !== undefined) setHostedError(notice);
        }
      }
      if (message.type === "message_failed") {
        if (buffers().some((buffer) => buffer.id === message.buffer_id)) {
          setComposerNotice(t(message.message_key));
        }
      }
      if (message.type === "command_specs_changed") {
        setCommandSpecs(message.specs);
      }
      if (message.type === "command_help_requested") {
        setComposerNotice(commandHelp(commandSpecs() ?? [], message.command));
      }
      if (message.type === "completion_result") {
        if (message.command_id === latestCompletionRequest) {
          const delay = completionDelay();
          if (delay === 0) setCompletion(message);
          else
            window.setTimeout(() => {
              if (message.command_id === latestCompletionRequest)
                setCompletion(message);
            }, delay);
        }
      }
      if (message.type === "focus_buffer_requested") {
        setFocusRequest({ bufferId: message.buffer_id });
      }
      if (message.type === "network_state_changed") {
        if (connectionStateKind(message.network.state) === "online") {
          setShellReady(true);
          setHostedError(undefined);
        } else {
          const messageKey = connectionFailureMessage(message.network.state);
          if (!shellReady() && messageKey !== undefined) {
            setHostedError(t(messageKey));
          }
        }
        if (
          !navigator.onLine &&
          !(
            typeof message.network.state === "object" &&
            "offline" in message.network.state &&
            message.network.state.offline.reason === "device_offline"
          )
        ) {
          void mountedClient
            .send({
              id: crypto.randomUUID(),
              request: {
                type: "set_device_online",
                network_id: message.network.id,
                online: false,
              },
            })
            .catch(() => undefined);
        }
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
      if (message.type === "buffers_changed") {
        setLoadedNetworkIds((current) =>
          new Set(current).add(message.network_id),
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
      if (!document.hidden) reconnectNetworks();
    };
    const reconnectNetworks = () => {
      for (const network of networks()) {
        void mountedClient
          .send({
            id: crypto.randomUUID(),
            request: { type: "reconnect", network_id: network.id },
          })
          .catch(() => undefined);
      }
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        mountedClient.checkLiveness();
        reconnectNetworks();
      }
    };
    const updateConnectivity = () => {
      for (const network of networks()) {
        void mountedClient
          .send({
            id: crypto.randomUUID(),
            request: {
              type: "set_device_online",
              network_id: network.id,
              online: navigator.onLine,
            },
          })
          .catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", updateVisibility);
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);
    window.addEventListener("pageshow", handlePageShow);
    updateVisibility();

    void startEngine(
      mountedClient,
      setEngineStatus,
      setHostedError,
      debugPassword,
      props.hostedSession,
      clientId,
    ).then((outcome) => {
      if (outcome === "reloading") return;
      if (outcome === "failed") {
        setStartupError("Couldn't start weblounge.");
      }
      setEngineReady(true);
      if (outcome === "ready" && props.hostedSession !== undefined) {
        cancelTokenExpiry = scheduleExpiry(
          props.hostedSession.token.expiresAt,
          () => void restartHostedAuthorization("expired"),
        );
      }
    });
    onCleanup(() => {
      disposed = true;
      cancelTokenExpiry();
      unregisterContextSurface();
      removeContextMenuHandler();
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("online", updateConnectivity);
      window.removeEventListener("offline", updateConnectivity);
      window.removeEventListener("pageshow", handlePageShow);
      unsubscribe();
      void mountedClient.close();
    });

    async function restartHostedAuthorization(
      reason: "expired" | "revoked" | "worker_restarted",
    ): Promise<void> {
      if (restartingHostedAuthorization) return;
      restartingHostedAuthorization = true;
      cancelTokenExpiry();
      setHostedError(
        reason === "worker_restarted"
          ? "Restoring the chat…"
          : "Your session expired. Signing in again…",
      );
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

  async function revealStartup(): Promise<void> {
    if (revealingStartup || startupRevealed()) return;
    revealingStartup = true;
    await props.beforeReveal?.();
    if (disposed) return;
    setStartupRevealed(true);
    props.onReady?.();
  }

  return (
    <div
      data-app-root="true"
      ref={(element) => {
        appRoot = element;
      }}
    >
      <p
        aria-hidden={startupRevealed() ? undefined : "true"}
        class="visually-hidden"
        role={startupRevealed() ? "status" : undefined}
      >
        {engineStatus()}
      </p>
      {!engineReady() ? null : startupError() !== undefined ? (
        startupRevealed() ? (
          <HostedStatus
            message={startupError() ?? ""}
            error
            onRetry={props.onRetryStartup}
          />
        ) : null
      ) : !shellReady() ? (
        startupRevealed() && hostedError() !== undefined ? (
          <HostedStatus
            message={hostedError() ?? ""}
            error
            onRetry={props.onRetryStartup}
          />
        ) : null
      ) : (
        <ResponsiveShell
          activeBufferId={initialBufferId()}
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
          onSelectBuffer={(bufferId) => {
            const path = pathForBuffer(bufferId);
            if (path !== undefined) writeLastViewedPath(path);
          }}
          pathForBuffer={pathForBuffer}
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
              .catch(() => undefined);
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
          onRetryNetwork={(networkId) => {
            if (client === undefined) return;
            void client.send({
              id: crypto.randomUUID(),
              request: { type: "reconnect", network_id: networkId },
            });
          }}
          onRetry={(bufferId, localSendId) => {
            if (client === undefined) return;
            void client.send({
              id: crypto.randomUUID(),
              request: {
                type: "retry_message",
                buffer_id: bufferId,
                local_send_id: localSendId,
              },
            });
          }}
        />
      )}
      <Show when={notifier.notice()}>
        {(notice) => (
          <Toast
            notice={notice()}
            onAction={runNoticeAction}
            onDismiss={notifier.dismiss}
          />
        )}
      </Show>
    </div>
  );

  function pathForBuffer(bufferId: number): string | undefined {
    const buffer = buffers().find((candidate) => candidate.id === bufferId);
    const network = networks().find(
      (candidate) => candidate.id === buffer?.network_id,
    );
    return buffer === undefined || network === undefined
      ? undefined
      : bufferPath(network, buffer);
  }

  function runNoticeAction(action: ActionId): void {
    const values = notifier.notice()?.message.values;
    const networkId = Number(values?.network_id);
    noticeActions.run(action, {
      bufferCount: buffers().length,
      listActive: false,
      ...(Number.isSafeInteger(networkId)
        ? { targetNetworkId: networkId }
        : {}),
      ...(values?.target === undefined ? {} : { targetNick: values.target }),
    });
  }
}

function completionDelay(): number {
  if (__DEBUG_IRC_CONFIG__ === null) return 0;
  const value = new URL(window.location.href).searchParams.get(
    "completion-delay",
  );
  if (value === null) return 0;
  const delay = Number.parseInt(value, 10);
  return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 1_000)) : 0;
}

function noticeAction(
  action: { readonly label: string; readonly run: string } | null,
): { readonly label: MessageKey; readonly run: ActionId } | undefined {
  if (
    action === null ||
    !isMessageKey(action.label) ||
    !isActionId(action.run)
  ) {
    return undefined;
  }
  return { label: action.label, run: action.run };
}

function noticeValues(
  values: Readonly<Record<string, string | undefined>>,
): MessageValues {
  return {
    ...(values.input === undefined ? {} : { input: values.input }),
    ...(values.network_id === undefined
      ? {}
      : { network_id: values.network_id }),
    ...(values.target === undefined ? {} : { target: values.target }),
    ...(values.text === undefined ? {} : { text: values.text }),
  };
}

async function startEngine(
  client: EngineClient,
  setStatus: (status: string) => void,
  setHostedError: (message: string) => void,
  debugPassword: string | null,
  hostedSession: HostedSession | undefined,
  clientId: string,
): Promise<"ready" | "failed" | "reloading"> {
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
    } else if (debugPassword !== null) {
      await connectDebugNetwork(client, debugPassword);
    }
    return "ready";
  } catch (error: unknown) {
    if (error instanceof IncompatibleBuildError) {
      return recoverFromBuildMismatch(setStatus) ? "reloading" : "failed";
    }
    setStatus("Engine failed to start");
    if (hostedSession !== undefined) {
      setHostedError("Couldn't start the chat.");
    }
    return "failed";
  }
}

async function connectDebugNetwork(
  client: EngineClient,
  password: string,
): Promise<void> {
  if (__DEBUG_IRC_CONFIG__ === null) return;
  await client.send({
    id: crypto.randomUUID(),
    request: {
      type: "connect",
      label: "Local Ergo",
      endpoint: __DEBUG_IRC_CONFIG__.endpoint,
      nickname: __DEBUG_IRC_CONFIG__.nickname,
      sasl: {
        account: __DEBUG_IRC_CONFIG__.account,
        password,
      },
      autojoin: [__DEBUG_IRC_CONFIG__.channel],
      allow_insecure: __DEBUG_IRC_CONFIG__.allowInsecure,
    },
  });
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
    setBuffers((current) =>
      current.map((buffer) =>
        buffer.id === message.buffer.id ? message.buffer : buffer,
      ),
    );
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
  } else if (message.type === "message_updated") {
    setMessages((current) => {
      const next = new Map(current);
      next.set(
        message.buffer_id,
        (current.get(message.buffer_id) ?? []).map((item) =>
          item.id === message.message.id ? message.message : item,
        ),
      );
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
  } else if (message.type === "message_retrying") {
    setMessages((current) => {
      const next = new Map(current);
      next.set(
        message.buffer_id,
        (current.get(message.buffer_id) ?? []).map((item) =>
          item.local_send_id === message.local_send_id
            ? { ...item, delivery: "optimistic" }
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
): boolean {
  if (storage.getItem(reloadMarker) === __BUILD_ID__) {
    setStatus("Engine update failed; reload site data to recover");
    return false;
  }

  storage.setItem(reloadMarker, __BUILD_ID__);
  reload();
  return true;
}
