import { createSignal, onCleanup, onMount } from "solid-js";
import { consumeDebugPassword } from "./debug-irc-config";
import { installDensity } from "./density/density";
import { createEngineClient } from "./engine/createEngineClient";
import type { EngineClient } from "./engine/EngineClient";
import { IncompatibleBuildError } from "./engine/EngineClient";
import type {
  BufferProjection,
  EngineClientMessage,
  MembershipProjection,
  MessageProjection,
  NetworkProjection,
} from "./engine/protocol";
import { DesktopShell } from "./shells/desktop/DesktopShell";
import { installSystemTheme } from "./theme/theme-controller";
import {
  contextMenuRegistry,
  installContextMenuHandler,
} from "./ui/context-menu";

const reloadMarker = "weblounge-build-reload";

interface AppProps {
  engineClient?: EngineClient;
}

export function App(props: AppProps) {
  const theme = installSystemTheme(document, window);
  const removeDensity = installDensity(document);
  onCleanup(() => theme.dispose());
  onCleanup(removeDensity);
  const [engineStatus, setEngineStatus] = createSignal("Starting engine…");
  const [engineNotice, setEngineNotice] = createSignal<string>();
  const [networks, setNetworks] = createSignal<NetworkProjection[]>([]);
  const [buffers, setBuffers] = createSignal<BufferProjection[]>([]);
  const [messages, setMessages] = createSignal<
    ReadonlyMap<number, readonly MessageProjection[]>
  >(new Map());
  const [memberships, setMemberships] = createSignal<
    ReadonlyMap<number, readonly MembershipProjection[]>
  >(new Map());
  let client: EngineClient | undefined;
  let appRoot: HTMLElement | undefined;

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
        setEngineNotice(
          "This browser uses one connection per tab because SharedWorker is unavailable.",
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

    const debugPassword = consumeDebugPassword(
      new URL(window.location.href),
      (path) => window.history.replaceState(window.history.state, "", path),
    );
    void startEngine(mountedClient, setEngineStatus, debugPassword);
    onCleanup(() => {
      unregisterContextSurface();
      removeContextMenuHandler();
      document.removeEventListener("visibilitychange", updateVisibility);
      unsubscribe();
      void mountedClient.close();
    });
  });

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
      <DesktopShell
        networks={networks()}
        buffers={buffers()}
        messages={messages()}
        memberships={memberships()}
        onMarkRead={(bufferId, through) => {
          if (client === undefined) return;
          void client.send({
            id: crypto.randomUUID(),
            command: { type: "mark_read", buffer_id: bufferId, through },
          });
        }}
        onLoadHistory={(bufferId) => {
          if (client === undefined) return;
          void client.send({
            id: crypto.randomUUID(),
            command: { type: "load_history", buffer_id: bufferId },
          });
        }}
        onSend={(bufferId, text) => {
          if (client === undefined) return;
          void client.send({
            id: crypto.randomUUID(),
            command: { type: "send_message", buffer_id: bufferId, text },
          });
        }}
      />
    </div>
  );
}

async function startEngine(
  client: EngineClient,
  setStatus: (status: string) => void,
  debugPassword: string | null,
): Promise<void> {
  try {
    await client.start({
      build_id: __BUILD_ID__,
      client_id: crypto.randomUUID(),
      last_revision: null,
      shell: "web",
    });
    sessionStorage.removeItem(reloadMarker);
    await client.send({
      id: crypto.randomUUID(),
      command: {
        type: "diagnostic",
        message: "wasm worker round trip complete",
      },
    });
    if (__DEBUG_IRC_CONFIG__ !== null && debugPassword !== null) {
      await client.send({
        id: crypto.randomUUID(),
        command: {
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
  }
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
