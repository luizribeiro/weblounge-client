import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  type ActionId,
  ActionRegistry,
  isActionId,
} from "./actions/action-registry";
import { commandHelp } from "./actions/command-help";
import {
  consumeDebugConnection,
  type DebugConnection,
} from "./debug-irc-config";
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
import type { PushDeploymentConfig } from "./engine/generated/PushDeploymentConfig";
import type { PushState } from "./engine/generated/PushState";
import type {
  BufferProjection,
  CommandSpec,
  CompletionResult,
  EngineClientMessage,
  MembershipProjection,
  MessageProjection,
  NetworkProjection,
} from "./engine/protocol";
import { migrateDraft } from "./features/composer/draft-storage";
import type { MemberWindow } from "./features/members/MemberPanel";
import {
  formatNotificationPromptVisibility,
  isIos,
  type NotificationPromptVisibility,
  shouldShowNotificationPrompt,
  supportsWebPush,
} from "./features/notifications/notification-prompt-visibility";
import { type HostedSession, OneShotAccessToken } from "./hosted/HostedSession";
import { HostedStatus } from "./hosted/HostedStatus";
import {
  requiresAuthorization,
  SessionTokenError,
  SessionTokenProvider,
} from "./hosted/session-token";
import { withStartupDeadline } from "./hosted/startup-deadline";
import { bufferPath, resolveBufferRoute } from "./navigation/buffer-route";
import {
  initialDestination,
  readLastViewedPath,
  writeLastViewedPath,
} from "./navigation/initial-buffer";
import {
  setEngineDebugReading,
  setNotificationDebugReading,
  setPushDebugSnapshot,
} from "./platform/debug-overlay";
import { setDebugOverlayEnabled } from "./platform/debug-overlays";
import { platformEnvironment } from "./platform/environment";
import { syncAppPushState } from "./platform/push/app-badge";
import { EnginePushDeviceStore } from "./platform/push/engine-device-store";
import {
  ForegroundLease,
  foregroundLeaseTabId,
} from "./platform/push/foreground-lease";
import {
  decodeOpenRouteMessage,
  type OpenRouteMessage,
} from "./platform/push/open-route-message";
import { buildPushDebugSnapshot } from "./platform/push/push-debug";
import {
  type PushRouteDiagnostic,
  PushSynchronizer,
} from "./platform/push/push-sync";
import { RelayClient } from "./platform/push/relay-client";
import { IndexedDbPushRouteStore } from "./platform/push/route-store";
import { ensurePushSubscription } from "./platform/push/subscription";
import {
  onServiceWorkerUpdateReady,
  serviceWorkerUpdateIsReady,
} from "./service-worker";
import { ResponsiveShell } from "./shells/ResponsiveShell";
import {
  isMessageKey,
  type MessageKey,
  type MessageValues,
  t,
  translate,
} from "./strings";
import {
  contextMenuRegistry,
  installContextMenuHandler,
} from "./ui/context-menu";
import { createNotifier } from "./ui/notices";
import { Toast } from "./ui/Toast";

const reloadMarker = "weblounge-build-reload";
const notificationPromptReadDeadlineMs = 2_000;

function pushConfigKey(config: PushDeploymentConfig): string {
  return `${config.relay}\0${config.relay_vapid}`;
}

function isPushSubscriptionChange(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "push_subscription_change"
  );
}

interface AppProps {
  beforeReveal?: () => Promise<void>;
  engineClient?: EngineClient;
  hostedSession?: HostedSession;
  pushConfig?: PushDeploymentConfig | undefined;
  onReady?: () => void;
  onHostedAuthorizationRequired?: (
    reason: "refresh_failed" | "revoked" | "worker_restarted",
  ) => void;
  onRetryStartup?: (() => void) | undefined;
  onStartupError?:
    | ((message: string, retry: (() => void) | undefined) => void)
    | undefined;
}

export function App(props: AppProps) {
  const clientId = crypto.randomUUID();
  const startupSyncRequired =
    props.hostedSession !== undefined ||
    (__DEBUG_IRC_CONFIG__ !== null &&
      new URL(window.location.href).searchParams.has("irc-password"));
  const [engineStatus, setEngineStatus] = createSignal(t("hosted.starting"));
  const notifier = createNotifier();
  const [hostedError, setHostedError] = createSignal<string>();
  const [shellReady, setShellReady] = createSignal(!startupSyncRequired);
  const [startupError, setStartupError] = createSignal<string>();
  const [engineReady, setEngineReady] = createSignal(false);
  const [engineStarted, setEngineStarted] = createSignal(false);
  const [startupRevealed, setStartupRevealed] = createSignal(false);
  const [startupContentReady, setStartupContentReady] = createSignal(
    !startupSyncRequired,
  );
  const [startupCapReached, setStartupCapReached] = createSignal(false);
  const [composerNotice, setComposerNotice] = createSignal<string>();
  const [commandSpecs, setCommandSpecs] = createSignal<CommandSpec[]>();
  const [completion, setCompletion] = createSignal<CompletionResult>();
  const [focusRequest, setFocusRequest] = createSignal<{ bufferId: number }>();
  const [pendingOpenRoute, setPendingOpenRoute] =
    createSignal<OpenRouteMessage>();
  const [bufferRemoval, setBufferRemoval] = createSignal<{
    bufferId: number;
    previousBufferId: number | undefined;
  }>();
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
  const [notificationPromptDismissed, setNotificationPromptDismissed] =
    createSignal<boolean>();
  const [notificationPermission, setNotificationPermission] =
    createSignal<NotificationPermission>(
      "Notification" in window ? Notification.permission : "default",
    );
  const [enginePushStates, setEnginePushStates] = createSignal<
    ReadonlyMap<number, PushState>
  >(new Map());
  const [relayPushStates, setRelayPushStates] = createSignal<
    ReadonlyMap<number, PushRouteDiagnostic>
  >(new Map());
  const [initialBufferId, setInitialBufferId] = createSignal<number>();
  let client: EngineClient | undefined;
  let pushSynchronizer: PushSynchronizer | undefined;
  let pushStartup: Promise<void> | undefined;
  let pushStartupKey: string | undefined;
  let pushRefresh: Promise<void> | undefined;
  let pushSetupGeneration = 0;
  let notificationPromptLoadId: string | undefined;
  let notificationPromptReadDeadline: number | undefined;
  let loadedPromptConfig: string | undefined;
  let foregroundLease: ForegroundLease | undefined;
  let appIsForeground = false;
  const pendingPushEvents: EngineClientMessage[] = [];
  const knownPushRequirements = new Map<number, EngineClientMessage>();
  let appRoot: HTMLElement | undefined;
  let latestCompletionRequest: string | undefined;
  let restartingHostedAuthorization = false;
  let hostedRefreshNetworkId: number | undefined;
  let preparedHostedNetwork: NetworkProjection | undefined;
  let resolvePreparedHostedNetwork = (_network: NetworkProjection) => {};
  const preparedHostedNetworkReady = new Promise<NetworkProjection>(
    (resolve) => {
      resolvePreparedHostedNetwork = resolve;
    },
  );
  let hostedRefreshPending = false;
  let hostedFallbackTimer: number | undefined;
  let engineInstance: string | undefined;
  let disposed = false;
  let revealingStartup = false;
  const [cachedChatListActive, setCachedChatListActive] = createSignal(false);
  let initialNavigationResolved = false;
  let lastMarkedBufferId: number | undefined;
  let pushedMessagesNetworkId: number | undefined;
  let startupCap: number | undefined;
  let startupSettleFrame: number | undefined;
  let startupConfirmFrame: number | undefined;
  let appPushStateSync = Promise.resolve();
  const startupOnlineNetworks = new Set<number>();
  const startupBufferNetworks = new Set<number>();
  const startupDirectNetworks = new Set<number>();
  const startupHistoryPending = new Set<number>();
  const startupHistoryComplete = new Set<number>();
  const storedNavigationPath = readLastViewedPath();
  const notificationPromptConditions = (): NotificationPromptVisibility => ({
    configured: props.pushConfig !== undefined,
    supported: supportsWebPush(window, navigator),
    permission: notificationPermission(),
    dismissed: notificationPromptDismissed(),
    ios: isIos(navigator),
    display: platformEnvironment().environment().display,
  });
  const notificationPromptVisible = () =>
    shouldShowNotificationPrompt(notificationPromptConditions());

  createEffect(() => {
    setNotificationDebugReading(
      window,
      formatNotificationPromptVisibility(notificationPromptConditions()),
    );
  });

  createEffect(() => {
    setPushDebugSnapshot(
      window,
      buildPushDebugSnapshot(
        notificationPromptConditions(),
        networks(),
        enginePushStates(),
        relayPushStates(),
      ),
    );
  });

  const syncEnginePushState = () => {
    const current = buffers();
    if (current.length === 0) return;
    const networkLabels = new Map(
      networks().map((network) => [network.id, network.label]),
    );
    appPushStateSync = appPushStateSync
      .then(() => syncAppPushState(current, networkLabels))
      .catch(() => undefined);
  };
  createEffect(syncEnginePushState);
  createEffect(() => {
    const config = props.pushConfig;
    const mountedClient = client;
    if (!engineStarted() || config === undefined || mountedClient === undefined)
      return;
    const configKey = `${config.relay}\0${config.relay_vapid}`;
    if (loadedPromptConfig === configKey) return;
    loadedPromptConfig = configKey;
    setNotificationPromptDismissed(undefined);
    const loadId = crypto.randomUUID();
    notificationPromptLoadId = loadId;
    if (notificationPromptReadDeadline !== undefined)
      window.clearTimeout(notificationPromptReadDeadline);
    // A worker-backed Settings read can remain pending when IndexedDB stalls.
    // Optional preference storage must not permanently suppress setup.
    notificationPromptReadDeadline = window.setTimeout(() => {
      if (notificationPromptLoadId === loadId)
        setNotificationPromptDismissed(false);
    }, notificationPromptReadDeadlineMs);
    void mountedClient
      .send({
        id: loadId,
        request: { type: "load_notification_prompt_dismissal" },
      })
      .catch(() => {
        if (notificationPromptLoadId !== loadId) return;
        if (notificationPromptReadDeadline !== undefined)
          window.clearTimeout(notificationPromptReadDeadline);
        notificationPromptReadDeadline = undefined;
        setNotificationPromptDismissed(false);
      });
    if ("Notification" in window && Notification.permission === "granted") {
      void startConfiguredPush(mountedClient);
    }
  });
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
      "debug.overlay": (context) => {
        if (context.debugOverlay === undefined) {
          setComposerNotice(
            "Usage: /debug <viewport|gestures|keyboard|push|off>",
          );
          return;
        }
        const root = document.getElementById("root");
        if (root === null) return;
        setDebugOverlayEnabled(root, window, context.debugOverlay);
        setComposerNotice(undefined);
      },
    },
    "other",
  );

  createEffect(() => {
    const blockingError =
      startupError() ?? (!shellReady() ? hostedError() : undefined);
    if (engineReady() && blockingError !== undefined) {
      props.onStartupError?.(blockingError, props.onRetryStartup);
      if (props.onStartupError !== undefined) return;
    }
    if (
      !engineReady() ||
      (startupError() === undefined &&
        !shellReady() &&
        hostedError() === undefined) ||
      (startupError() === undefined &&
        hostedError() === undefined &&
        !startupContentReady() &&
        !startupCapReached())
    ) {
      return;
    }
    void revealStartup();
  });

  createEffect(() => {
    const pending = pendingOpenRoute();
    if (pending === undefined) return;
    const network = networks().find(
      (candidate) =>
        candidate.label.toLowerCase() === pending.route.network.toLowerCase(),
    );
    if (network !== undefined && pushedMessagesNetworkId !== network.id) {
      pushedMessagesNetworkId = network.id;
      void client
        ?.send({
          id: crypto.randomUUID(),
          request: {
            type: "load_pushed_messages",
            network_id: network.id,
          },
        })
        .catch(() => undefined);
    }
    const resolved = resolveBufferRoute(pending.route, networks(), buffers());
    if (resolved?.kind !== "buffer") return;
    setPendingOpenRoute(undefined);
    pushedMessagesNetworkId = undefined;
    setFocusRequest({ bufferId: resolved.bufferId });
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
    const handleServiceWorkerMessage = (event: MessageEvent<unknown>) => {
      const message = decodeOpenRouteMessage(event.data);
      if (message !== undefined) setPendingOpenRoute(message);
      if (isPushSubscriptionChange(event.data)) {
        void refreshConfiguredPush(mountedClient);
      }
    };
    navigator.serviceWorker?.addEventListener(
      "message",
      handleServiceWorkerMessage,
    );
    const debugConnection =
      __DEBUG_IRC_CONFIG__ === null
        ? null
        : consumeDebugConnection(new URL(window.location.href), (path) =>
            window.history.replaceState(window.history.state, "", path),
          );
    const unsubscribe = mountedClient.subscribe((message) => {
      if (message.type === "push_route_required") {
        knownPushRequirements.set(message.network_id, message);
      }
      if (message.type === "push_state_changed") {
        setEnginePushStates((current) =>
          new Map(current).set(message.network_id, message.state),
        );
        if (message.state.status === "unsupported") {
          knownPushRequirements.delete(message.network_id);
        }
      }
      if (
        pushSynchronizer === undefined &&
        props.pushConfig !== undefined &&
        (message.type === "push_route_required" ||
          message.type === "push_state_changed")
      ) {
        pendingPushEvents.push(message);
      }
      if (message.type === "hosted_token_required") {
        void refreshHostedToken(message.network_id);
        return;
      }
      if (
        message.type === "notification_prompt_dismissal_loaded" &&
        message.command_id === notificationPromptLoadId
      ) {
        if (notificationPromptReadDeadline !== undefined)
          window.clearTimeout(notificationPromptReadDeadline);
        notificationPromptReadDeadline = undefined;
        setNotificationPromptDismissed(message.dismissed);
      }
      if (message.type === "ready") {
        const restarted =
          engineInstance !== undefined &&
          engineInstance !== message.engine_instance;
        engineInstance = message.engine_instance;
        if (restarted) {
          if (props.hostedSession !== undefined) {
            void restartHostedAuthorization("worker_restarted");
          } else if (debugConnection !== null) {
            void connectDebugNetwork(mountedClient, debugConnection);
          }
        }
      }
      if (message.type === "diagnostic") {
        if (isMessageKey(message.message)) {
          setEngineDebugReading(
            window,
            message.message,
            translate(message.message),
          );
        } else {
          setEngineStatus(
            t("debug.engine_ready", { message: message.message }),
          );
        }
      }
      if (message.type === "notice") {
        if (
          message.key !== "engine.mark_read_failed" &&
          isMessageKey(message.key)
        ) {
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
        const notice = translate(message.key, message.values);
        if (message.key === "engine.connection_failed") {
          if (props.hostedSession !== undefined && !shellReady())
            setHostedError(notice);
        }
      }
      if (message.type === "message_failed") {
        if (buffers().some((buffer) => buffer.id === message.buffer_id)) {
          setComposerNotice(translate(message.message_key));
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
        if (props.hostedSession !== undefined) {
          preparedHostedNetwork = message.network;
          resolvePreparedHostedNetwork(message.network);
        }
        if (connectionStateKind(message.network.state) === "online") {
          setShellReady(true);
          setHostedError(undefined);
          if (!startupRevealed() && startupSyncRequired) {
            startupOnlineNetworks.add(message.network.id);
            startStartupCap();
            scheduleStartupContentCheck();
          }
        } else {
          const messageKey = connectionFailureMessage(message.network.state);
          if (!shellReady() && messageKey !== undefined) {
            setHostedError(translate(messageKey));
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
        if (
          !startupRevealed() &&
          startupOnlineNetworks.has(message.network_id)
        ) {
          startupBufferNetworks.add(message.network_id);
          trackStartupBuffers(message.buffers);
        }
      }
      if (message.type === "chat_list_snapshot_loaded") {
        setCachedChatListActive(true);
        setBuffers(message.buffers);
        setLoadedNetworkIds((current) =>
          new Set(current).add(message.network_id),
        );
        setShellReady(true);
        setStartupContentReady(true);
      }
      if (message.type === "pushed_messages_loaded") {
        setLoadedNetworkIds((current) =>
          new Set(current).add(message.network_id),
        );
        setShellReady(true);
        setStartupContentReady(true);
      }
      if (message.type === "chat_list_live") {
        setCachedChatListActive(false);
        setBuffers(message.buffers);
      }
      if (message.type === "buffer_added" && !startupRevealed()) {
        trackStartupBuffers([message.buffer]);
      }
      if (message.type === "recent_directs_ready" && !startupRevealed()) {
        startupDirectNetworks.add(message.network_id);
        scheduleStartupContentCheck();
      }
      if (
        message.type === "history_state_changed" &&
        !message.loading &&
        !startupRevealed()
      ) {
        startupHistoryComplete.add(message.buffer_id);
        startupHistoryPending.delete(message.buffer_id);
        scheduleStartupContentCheck();
      }
      if (message.type === "buffer_snapshot" && !startupRevealed()) {
        startupHistoryComplete.add(message.buffer_id);
        startupHistoryPending.delete(message.buffer_id);
        scheduleStartupContentCheck();
      }
      if (message.type === "draft_key_changed") {
        migrateDraft(message.previous, message.current);
      }
      if (message.type === "buffer_removed") {
        const current = buffers();
        const index = current.findIndex(
          (buffer) => buffer.id === message.buffer_id,
        );
        setBufferRemoval({
          bufferId: message.buffer_id,
          previousBufferId: index > 0 ? current[index - 1]?.id : undefined,
        });
        setMemberWindows(
          (windows) =>
            new Map(
              [...windows].filter(
                ([, memberWindow]) =>
                  memberWindow.buffer_id !== message.buffer_id,
              ),
            ),
        );
      }
      const stagedLiveBufferEvent =
        cachedChatListActive() &&
        (message.type === "buffers_changed" ||
          message.type === "buffer_added" ||
          (message.type === "buffer_updated" &&
            message.buffer.cached !== true) ||
          message.type === "unread_changed");
      if (!stagedLiveBufferEvent) {
        applyDebugEvent(
          message,
          setNetworks,
          setBuffers,
          setMessages,
          setMemberships,
        );
      }
    });
    let updateReady = serviceWorkerUpdateIsReady();
    const publishUpdateReady = () => {
      if (!engineStarted() || !updateReady) return;
      void mountedClient
        .send({
          id: crypto.randomUUID(),
          request: { type: "set_update_ready", ready: true },
        })
        .catch(() => undefined);
    };
    const unsubscribeUpdateReady = onServiceWorkerUpdateReady(() => {
      updateReady = true;
      publishUpdateReady();
    });
    const setAppForeground = (foreground: boolean) => {
      appIsForeground = foreground;
      mountedClient.setVisibility(foreground ? "visible" : "hidden");
      foregroundLease?.setForeground(foreground);
      if (foreground) {
        syncEnginePushState();
        reconnectNetworks();
        void refreshConfiguredPush(mountedClient);
      }
    };
    const updateVisibility = () => {
      if ("Notification" in window)
        setNotificationPermission(Notification.permission);
      setAppForeground(!document.hidden && document.hasFocus());
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
        updateVisibility();
      }
    };
    const handlePageHide = () => setAppForeground(false);
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
    window.addEventListener("focus", updateVisibility);
    window.addEventListener("blur", updateVisibility);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("online", updateConnectivity);
    window.addEventListener("offline", updateConnectivity);
    window.addEventListener("pageshow", handlePageShow);
    updateVisibility();
    void startEngine(
      mountedClient,
      setEngineStatus,
      debugConnection,
      props.hostedSession,
      clientId,
      () => setEngineReady(true),
      () =>
        preparedHostedNetwork ?? networks()[0] ?? preparedHostedNetworkReady,
    ).then((outcome) => {
      if (outcome === "reloading") return;
      if (outcome === "failed") {
        setStartupError("Couldn't start weblounge.");
      }
      if (typeof outcome === "object") {
        void handleInitialHostedFailure(outcome.error);
      }
      setEngineStarted(outcome !== "failed");
      publishUpdateReady();
      setEngineReady(true);
    });
    onCleanup(() => {
      disposed = true;
      pushSetupGeneration += 1;
      if (hostedFallbackTimer !== undefined)
        window.clearTimeout(hostedFallbackTimer);
      if (notificationPromptReadDeadline !== undefined)
        window.clearTimeout(notificationPromptReadDeadline);
      setNotificationDebugReading(window, undefined);
      setPushDebugSnapshot(window, undefined);
      clearStartupWaits();
      unregisterContextSurface();
      removeContextMenuHandler();
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("focus", updateVisibility);
      window.removeEventListener("blur", updateVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("online", updateConnectivity);
      window.removeEventListener("offline", updateConnectivity);
      window.removeEventListener("pageshow", handlePageShow);
      navigator.serviceWorker?.removeEventListener(
        "message",
        handleServiceWorkerMessage,
      );
      unsubscribe();
      unsubscribeUpdateReady();
      foregroundLease?.dispose();
      pushSynchronizer?.dispose();
      void mountedClient.close();
    });
  });

  async function startConfiguredPush(
    mountedClient: EngineClient,
  ): Promise<void> {
    const config = props.pushConfig;
    const session = props.hostedSession;
    if (config === undefined || session === undefined) return;
    const key = pushConfigKey(config);
    if (pushStartupKey !== key) {
      pushSetupGeneration += 1;
      pushSynchronizer?.dispose();
      foregroundLease?.dispose();
      pushSynchronizer = undefined;
      foregroundLease = undefined;
      pushStartup = undefined;
      pushStartupKey = key;
    }
    if (pushStartup !== undefined) return pushStartup;
    const generation = pushSetupGeneration;
    const attempt = runConfiguredPush(
      mountedClient,
      config,
      session,
      generation,
    );
    pushStartup = attempt;
    try {
      await attempt;
      if (pushSynchronizer === undefined && pushStartup === attempt) {
        pushStartup = undefined;
      }
    } catch (error: unknown) {
      if (pushStartup === attempt) pushStartup = undefined;
      throw error;
    }
  }

  async function runConfiguredPush(
    mountedClient: EngineClient,
    config: PushDeploymentConfig,
    session: HostedSession,
    generation: number,
  ): Promise<void> {
    if (
      !("Notification" in window) ||
      Notification.permission !== "granted" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    if (disposed || generation !== pushSetupGeneration) return;
    const subscription = await ensurePushSubscription(
      registration,
      config.relay_vapid,
    );
    if (
      subscription.status !== "ready" ||
      disposed ||
      generation !== pushSetupGeneration
    )
      return;
    const relay = new RelayClient(config.relay);
    const devices = new EnginePushDeviceStore(mountedClient);
    const lease = new ForegroundLease({
      renew: (device, tabId) => relay.renewLease(device, tabId),
      release: (device, tabId) => relay.releaseLease(device, tabId),
      tabId: foregroundLeaseTabId(),
    });
    lease.setForeground(appIsForeground);
    const storedDevice = await devices
      .load(config.relay)
      .catch(() => undefined);
    if (disposed || generation !== pushSetupGeneration) {
      lease.dispose();
      return;
    }
    if (storedDevice !== undefined) {
      lease.setDevice({
        id: storedDevice.device_id,
        secret: storedDevice.secret,
      });
    }
    const synchronizer = new PushSynchronizer({
      engine: mountedClient,
      relay,
      relayOrigin: config.relay,
      target: subscription.target,
      devices,
      routes: new IndexedDbPushRouteStore(),
      routeContext: (networkId) => {
        const network = networks().find(
          (candidate) => candidate.id === networkId,
        );
        return network === undefined
          ? undefined
          : { networkLabel: network.label, nickname: network.nickname };
      },
      acquireSessionToken: async () => {
        try {
          const token = await new SessionTokenProvider(
            session.sessionTokenEndpoint,
          ).acquire();
          return token.accessToken;
        } catch (error: unknown) {
          if (requiresAuthorization(error)) {
            void restartHostedAuthorization("revoked");
          }
          throw error;
        }
      },
      onAuthorizationRequired: () => void restartHostedAuthorization("revoked"),
      onDeviceReady: (device) => lease.setDevice(device),
      onRouteDiagnostic: (diagnostic) =>
        setRelayPushStates((current) =>
          new Map(current).set(diagnostic.networkId, diagnostic),
        ),
    });
    foregroundLease = lease;
    pushSynchronizer = synchronizer;
    const queuedEvents = pendingPushEvents.splice(0);
    const queuedRequirements = new Set(
      queuedEvents
        .filter((event) => event.type === "push_route_required")
        .map((event) => event.network_id),
    );
    for (const [networkId, event] of knownPushRequirements) {
      if (queuedRequirements.has(networkId)) continue;
      synchronizer.handle(event);
    }
    for (const event of queuedEvents) synchronizer.handle(event);
    await synchronizer.refreshTarget(subscription.target);
    if (disposed || generation !== pushSetupGeneration) {
      synchronizer.dispose();
      lease.dispose();
      return;
    }
  }

  function refreshConfiguredPush(mountedClient: EngineClient): Promise<void> {
    pushRefresh ??= runPushRefresh(mountedClient).finally(() => {
      pushRefresh = undefined;
    });
    return pushRefresh;
  }

  async function runPushRefresh(mountedClient: EngineClient): Promise<void> {
    const config = props.pushConfig;
    if (config === undefined || !engineStarted()) return;
    const key = pushConfigKey(config);
    if (pushSynchronizer === undefined || pushStartupKey !== key) {
      await startConfiguredPush(mountedClient);
      return;
    }
    if (
      !("Notification" in window) ||
      Notification.permission !== "granted" ||
      !("serviceWorker" in navigator)
    )
      return;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await ensurePushSubscription(
      registration,
      config.relay_vapid,
    );
    if (subscription.status === "ready" && pushStartupKey === key) {
      await pushSynchronizer?.refreshTarget(subscription.target);
    }
  }

  function dismissNotificationPrompt(): void {
    setNotificationPromptDismissed(true);
    if (client === undefined) return;
    void client
      .send({
        id: crypto.randomUUID(),
        request: { type: "dismiss_notification_prompt" },
      })
      .catch(() => undefined);
  }

  function turnOnNotifications(): void {
    const permission = Notification.requestPermission();
    void permission
      .then(async (result) => {
        setNotificationPermission(result);
        if (result === "granted" && client !== undefined) {
          await startConfiguredPush(client);
        }
      })
      .catch(() => undefined);
  }

  async function restartHostedAuthorization(
    reason: "refresh_failed" | "revoked" | "worker_restarted",
  ): Promise<void> {
    if (restartingHostedAuthorization) return;
    restartingHostedAuthorization = true;
    setHostedError(
      reason === "worker_restarted"
        ? t("hosted.restoring")
        : t("hosted.session_expired"),
    );
    if (reason !== "worker_restarted") {
      await pushSynchronizer?.signOut().catch(() => undefined);
    }
    const network = networks()[0];
    if (network !== undefined && client !== undefined) {
      await client
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

  async function handleInitialHostedFailure(error: unknown): Promise<void> {
    if (requiresAuthorization(error)) {
      await restartHostedAuthorization("revoked");
      return;
    }
    if (error instanceof Error) setHostedError(error.message);
    const network = networks()[0];
    if (network !== undefined && client !== undefined) {
      await client
        .send({
          id: crypto.randomUUID(),
          request: {
            type: "hosted_token_unavailable",
            network_id: network.id,
          },
        })
        .catch(() => undefined);
    }
    if (error instanceof SessionTokenError && error.kind === "transient") {
      // wait-ok: a bounded recovery window lets the visible Retry act first.
      hostedFallbackTimer = window.setTimeout(() => {
        hostedFallbackTimer = undefined;
        void restartHostedAuthorization("refresh_failed");
      }, 3_000);
    }
  }

  async function refreshHostedToken(networkId: number): Promise<void> {
    const session = props.hostedSession;
    if (session === undefined || client === undefined || hostedRefreshPending)
      return;
    hostedRefreshPending = true;
    if (hostedFallbackTimer !== undefined) {
      window.clearTimeout(hostedFallbackTimer);
      hostedFallbackTimer = undefined;
    }
    try {
      const token = await new SessionTokenProvider(
        session.sessionTokenEndpoint,
      ).acquire();
      hostedRefreshNetworkId = undefined;
      setHostedError(undefined);
      await client.send({
        id: crypto.randomUUID(),
        request: {
          type: "reconnect_hosted",
          network_id: networkId,
          oauth_token: token.accessToken,
        },
      });
    } catch (error: unknown) {
      if (requiresAuthorization(error)) {
        await restartHostedAuthorization("revoked");
        return;
      }
      hostedRefreshNetworkId = networkId;
      if (error instanceof Error) setHostedError(error.message);
      await client
        .send({
          id: crypto.randomUUID(),
          request: { type: "hosted_token_unavailable", network_id: networkId },
        })
        .catch(() => undefined);
      if (error instanceof SessionTokenError && error.kind === "transient") {
        // wait-ok: a bounded recovery window lets the visible Retry act first.
        hostedFallbackTimer = window.setTimeout(() => {
          hostedFallbackTimer = undefined;
          void restartHostedAuthorization("refresh_failed");
        }, 3_000);
      }
    } finally {
      hostedRefreshPending = false;
    }
  }

  async function revealStartup(): Promise<void> {
    if (revealingStartup || startupRevealed()) return;
    revealingStartup = true;
    clearStartupWaits();
    await props.beforeReveal?.();
    if (disposed) return;
    setStartupRevealed(true);
    props.onReady?.();
  }

  function startStartupCap(): void {
    if (startupCap !== undefined) return;
    // wait-ok: this is the product's fixed upper bound for startup hydration.
    startupCap = window.setTimeout(() => {
      startupCap = undefined;
      setStartupCapReached(true);
    }, 400);
  }

  function trackStartupBuffers(current: readonly BufferProjection[]): void {
    cancelStartupSettle();
    for (const buffer of current) {
      if (buffer.kind !== "server" && !startupHistoryComplete.has(buffer.id)) {
        startupHistoryPending.add(buffer.id);
      }
    }
    scheduleStartupContentCheck();
  }

  function scheduleStartupContentCheck(): void {
    cancelStartupSettle();
    if (
      startupOnlineNetworks.size === 0 ||
      [...startupOnlineNetworks].some(
        (networkId) =>
          !startupBufferNetworks.has(networkId) ||
          !startupDirectNetworks.has(networkId),
      ) ||
      startupHistoryPending.size > 0
    ) {
      return;
    }
    startupSettleFrame = requestAnimationFrame(() => {
      startupSettleFrame = undefined;
      startupConfirmFrame = requestAnimationFrame(() => {
        startupConfirmFrame = undefined;
        if (startupHistoryPending.size > 0) return;
        if (startupCap !== undefined) window.clearTimeout(startupCap);
        startupCap = undefined;
        setStartupContentReady(true);
      });
    });
  }

  function cancelStartupSettle(): void {
    if (startupSettleFrame !== undefined)
      cancelAnimationFrame(startupSettleFrame);
    if (startupConfirmFrame !== undefined)
      cancelAnimationFrame(startupConfirmFrame);
    startupSettleFrame = undefined;
    startupConfirmFrame = undefined;
  }

  function clearStartupWaits(): void {
    if (startupCap !== undefined) window.clearTimeout(startupCap);
    startupCap = undefined;
    cancelStartupSettle();
  }

  return (
    <div
      data-app-root="true"
      data-chat-list-hydrating={cachedChatListActive() || undefined}
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
        startupRevealed() || props.onStartupError === undefined ? (
          <HostedStatus
            message={startupError() ?? ""}
            error
            onRetry={props.onRetryStartup}
          />
        ) : null
      ) : !shellReady() ? (
        (startupRevealed() || props.onStartupError === undefined) &&
        hostedError() !== undefined ? (
          <HostedStatus
            message={hostedError() ?? ""}
            error
            onRetry={() => {
              if (hostedRefreshNetworkId === undefined) {
                props.onRetryStartup?.();
                return;
              }
              void refreshHostedToken(hostedRefreshNetworkId);
            }}
          />
        ) : null
      ) : (
        <ResponsiveShell
          activeBufferId={initialBufferId()}
          hydrating={cachedChatListActive()}
          memberViewScope={clientId}
          networks={networks()}
          notificationPromptVisible={notificationPromptVisible()}
          onDismissNotificationPrompt={dismissNotificationPrompt}
          buffers={buffers()}
          bufferRemoval={bufferRemoval()}
          commandSpecs={commandSpecs()}
          composerNotice={composerNotice()}
          completion={completion()}
          focusRequest={focusRequest()}
          messages={messages()}
          memberships={memberships()}
          memberWindows={memberWindows()}
          onMarkRead={(bufferId, through) => {
            if (client === undefined) return;
            lastMarkedBufferId = bufferId;
            void client
              .send({
                id: crypto.randomUUID(),
                request: { type: "mark_read", buffer_id: bufferId, through },
              })
              .catch(() => undefined);
          }}
          onLoadHistory={(bufferId) => {
            if (client === undefined) return;
            void client
              .send({
                id: crypto.randomUUID(),
                request: { type: "load_history", buffer_id: bufferId },
              })
              .catch(() => undefined);
          }}
          onSelectBuffer={(bufferId) => {
            if (
              client !== undefined &&
              lastMarkedBufferId !== undefined &&
              lastMarkedBufferId !== bufferId
            ) {
              void client
                .send({
                  id: crypto.randomUUID(),
                  request: {
                    type: "cancel_deferred_read",
                    buffer_id: lastMarkedBufferId,
                  },
                })
                .catch(() => undefined);
              lastMarkedBufferId = undefined;
            }
            const path = pathForBuffer(bufferId);
            if (path !== undefined) writeLastViewedPath(path);
          }}
          onTurnOnNotifications={turnOnNotifications}
          pathForBuffer={pathForBuffer}
          onSend={(bufferId, text) => {
            if (client === undefined) return Promise.resolve(false);
            setComposerNotice(undefined);
            const uiResult = noticeActions.runInput(text, {
              bufferCount: buffers().length,
              listActive: false,
            });
            if (uiResult !== undefined)
              return Promise.resolve(uiResult === "ran");
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
                    ? translate(error.messageKey, {
                        input: text,
                        ...error.values,
                      })
                    : t("engine.command_failed"),
                );
                return false;
              });
          }}
          onRequestCompletion={(bufferId, input, cursor, explicit) => {
            if (client === undefined) return;
            const id = crypto.randomUUID();
            latestCompletionRequest = id;
            const uiCompletion = noticeActions.completeInput(
              id,
              bufferId,
              input,
              cursor,
            );
            if (uiCompletion !== undefined) {
              setCompletion(uiCompletion);
              return;
            }
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
            noticeActions.run("buffer.open-direct", {
              bufferCount: buffers().length,
              listActive: false,
              targetNetworkId: networkId,
              targetNick: nick,
            });
          }}
          onDeferDirectIdentity={(bufferId) => {
            if (client === undefined) return;
            void client.send({
              id: crypto.randomUUID(),
              request: {
                type: "defer_direct_identity",
                buffer_id: bufferId,
              },
            });
          }}
          onTrustDirectIdentity={(bufferId) => {
            if (client === undefined) return;
            void client.send({
              id: crypto.randomUUID(),
              request: {
                type: "trust_direct_identity",
                buffer_id: bufferId,
              },
            });
          }}
          onRetryNetwork={(networkId) => {
            if (client === undefined) return;
            const network = networks().find(
              (candidate) => candidate.id === networkId,
            );
            if (
              props.hostedSession !== undefined &&
              network !== undefined &&
              typeof network.state === "object" &&
              "failed" in network.state &&
              network.state.failed.reason === "authentication"
            ) {
              void restartHostedAuthorization("revoked");
              return;
            }
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
  debugConnection: DebugConnection | null,
  hostedSession: HostedSession | undefined,
  clientId: string,
  onEngineReady: () => void,
  hostedNetwork: () => NetworkProjection | Promise<NetworkProjection>,
): Promise<"ready" | "failed" | "reloading" | { readonly error: unknown }> {
  try {
    await withStartupDeadline(
      async () => {
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
            message: t("debug.wasm_round_trip"),
          },
        });
        if (hostedSession !== undefined) {
          await client.send({
            id: crypto.randomUUID(),
            request: {
              type: "prepare_hosted",
              label: hostedSession.network.name,
              endpoint: hostedSession.network.endpoint,
              nickname: "*",
              autojoin: hostedSession.network.autojoin,
            },
          });
        } else if (debugConnection !== null) {
          await connectDebugNetwork(client, debugConnection);
        }
      },
      () => new Error(t("shell.engine_timeout")),
    );
    onEngineReady();
  } catch (error: unknown) {
    if (hostedSession?.startupCancelled?.() === true) return "reloading";
    if (error instanceof IncompatibleBuildError) {
      return recoverFromBuildMismatch(setStatus) ? "reloading" : "failed";
    }
    console.error(
      "[weblounge startup] The chat engine failed to start.",
      error,
    );
    await client.close().catch(() => undefined);
    setStatus(t("shell.engine_start_failed"));
    return "failed";
  }
  if (hostedSession === undefined) return "ready";
  try {
    const pendingToken = await hostedSession.token;
    const token =
      pendingToken instanceof OneShotAccessToken
        ? pendingToken
        : pendingToken.type === "token"
          ? pendingToken.token
          : (() => {
              throw pendingToken.error;
            })();
    const network = await hostedNetwork();
    if (connectionStateKind(network.state) !== "online") {
      await client.send({
        id: crypto.randomUUID(),
        request: {
          type: "reconnect_hosted",
          network_id: network.id,
          oauth_token: token.take(),
        },
      });
    }
    return "ready";
  } catch (error: unknown) {
    return { error };
  }
}

async function connectDebugNetwork(
  client: EngineClient,
  connection: DebugConnection,
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
        password: connection.password,
      },
      autojoin: [
        __DEBUG_IRC_CONFIG__.channel,
        ...connection.additionalAutojoin.filter(
          (channel) => channel !== __DEBUG_IRC_CONFIG__?.channel,
        ),
      ],
      allow_insecure: __DEBUG_IRC_CONFIG__.allowInsecure,
    },
  });
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
  } else if (message.type === "buffer_removed") {
    setBuffers((current) =>
      current.filter((buffer) => buffer.id !== message.buffer_id),
    );
    setMessages((current) => withoutMapKey(current, message.buffer_id));
    setMemberships((current) => withoutMapKey(current, message.buffer_id));
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
  } else if (message.type === "buffer_snapshot") {
    setMessages((current) =>
      new Map(current).set(message.buffer_id, message.messages),
    );
    setMemberships((current) =>
      new Map(current).set(message.buffer_id, message.memberships),
    );
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

function withoutMapKey<Value>(
  current: ReadonlyMap<number, Value>,
  key: number,
): ReadonlyMap<number, Value> {
  const next = new Map(current);
  next.delete(key);
  return next;
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
