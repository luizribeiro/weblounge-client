import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  type CommandContext,
  type CommandId,
  CommandRegistry,
  detectPlatform,
} from "../../commands/command-registry";
import type {
  BufferProjection,
  MembershipProjection,
  MessageProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { Composer } from "../../features/composer/Composer";
import { ConversationHeader } from "../../features/conversation/ConversationHeader";
import {
  MessageList,
  type MessageListController,
} from "../../features/conversation/MessageList";
import {
  Sidebar,
  type SidebarListController,
} from "../../features/sidebar/Sidebar";
import styles from "./DesktopShell.module.css";
import { createSinglePane, showInFocusedPane } from "./pane-layout";

interface DesktopShellProps {
  readonly networks: readonly NetworkProjection[];
  readonly buffers: readonly BufferProjection[];
  readonly messages: ReadonlyMap<number, readonly MessageProjection[]>;
  readonly memberships: ReadonlyMap<number, readonly MembershipProjection[]>;
  readonly onSend: (bufferId: number, text: string) => void;
  readonly onMarkRead: (bufferId: number, through: number) => void;
  readonly onLoadHistory: (bufferId: number) => void;
}

export function DesktopShell(props: DesktopShellProps) {
  const [layout, setLayout] = createSignal(createSinglePane());
  const [sidebarShown, setSidebarShown] = createSignal(true);
  const [atLiveEdge, setAtLiveEdge] = createSignal(false);
  const [foreground, setForeground] = createSignal(
    document.visibilityState === "visible" && document.hasFocus(),
  );
  let listController: SidebarListController | undefined;
  let messageListController: MessageListController | undefined;
  let navigationCommitted = false;
  let knownBufferCount = props.buffers.length;
  const requestedHistory = new Set<number>();
  const activeBuffer = createMemo(() =>
    props.buffers.find((buffer) => buffer.id === layout().root.bufferId),
  );
  const visibleBufferIds = createMemo<ReadonlySet<number>>(() => {
    const buffer = activeBuffer();
    return new Set(buffer === undefined ? [] : [buffer.id]);
  });
  const context = (): CommandContext => ({
    bufferCount: props.buffers.length,
    listActive: sidebarShown(),
  });
  const showBuffer = (bufferId: number | undefined, deliberate = false) => {
    if (bufferId !== undefined) {
      if (deliberate) navigationCommitted = true;
      setLayout((current) => showInFocusedPane(current, bufferId));
    }
  };
  const moveBuffer = (offset: -1 | 1) => {
    const ids = orderedBufferIds(props.networks, props.buffers);
    const current = layout().root.bufferId;
    if (ids.length < 2 || current === undefined) return;
    const index = Math.max(0, ids.indexOf(current));
    showBuffer(ids[(index + offset + ids.length) % ids.length], true);
  };
  const registry = new CommandRegistry(
    {
      "buffer.next": () => moveBuffer(1),
      "buffer.open": () => {},
      "buffer.previous": () => moveBuffer(-1),
      "list.next": () => listController?.next(),
      "list.open": () => listController?.open(),
      "list.previous": () => listController?.previous(),
      "members.toggle": () => {},
      "message.jump-bottom": () => messageListController?.jumpBottom(),
      "network.add": () => {},
      "network.open-server": (command) =>
        showBuffer(command.targetBufferId, true),
      "pane.show-buffer": (command) => showBuffer(command.targetBufferId, true),
      "settings.open": () => {},
      "sidebar.toggle": () => setSidebarShown((shown) => !shown),
      "switcher.open": () => {},
    },
    detectPlatform(navigator),
  );
  const run = (id: CommandId) => registry.run(id, context());

  createEffect(() => {
    const buffer = activeBuffer();
    const latest = latestCommitted(props.messages.get(buffer?.id ?? -1) ?? []);
    if (
      buffer === undefined ||
      buffer.unread === 0 ||
      latest === undefined ||
      !atLiveEdge() ||
      !foreground()
    ) {
      return;
    }
    const timeout = window.setTimeout(
      () => props.onMarkRead(buffer.id, latest.id),
      500,
    );
    onCleanup(() => window.clearTimeout(timeout));
  });

  createEffect(() => {
    if (props.buffers.length > knownBufferCount) {
      showBuffer(props.buffers.at(-1)?.id, true);
    }
    knownBufferCount = props.buffers.length;
  });

  createEffect(() => {
    const buffer = activeBuffer();
    if (
      buffer === undefined ||
      buffer.kind === "server" ||
      requestedHistory.has(buffer.id)
    ) {
      return;
    }
    requestedHistory.add(buffer.id);
    props.onLoadHistory(buffer.id);
  });

  createEffect(() => {
    if (navigationCommitted) return;
    const preferred = preferredInitialBuffer(props.buffers);
    if (preferred?.id !== activeBuffer()?.id) showBuffer(preferred?.id);
  });

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      registry.handleKeydown(event, context());
    };
    document.addEventListener("keydown", handleKeydown);
    const updateForeground = () =>
      setForeground(
        document.visibilityState === "visible" && document.hasFocus(),
      );
    document.addEventListener("visibilitychange", updateForeground);
    window.addEventListener("focus", updateForeground);
    window.addEventListener("blur", updateForeground);
    onCleanup(() => {
      document.removeEventListener("keydown", handleKeydown);
      document.removeEventListener("visibilitychange", updateForeground);
      window.removeEventListener("focus", updateForeground);
      window.removeEventListener("blur", updateForeground);
    });
  });

  return (
    <div class={styles.shell} data-desktop-shell="true">
      {sidebarShown() && (
        <Sidebar
          activeBufferId={activeBuffer()?.id}
          buffers={props.buffers}
          commandContext={context()}
          networks={props.networks}
          registerListController={(controller) => {
            listController = controller;
          }}
          registry={registry}
          visibleBufferIds={visibleBufferIds()}
        />
      )}
      <main
        class={styles.main}
        data-chromeless={sidebarShown() ? "false" : "true"}
      >
        {activeBuffer() !== undefined ? (
          <section
            class={styles.conversation}
            data-buffer-title={activeBuffer()?.title}
          >
            <ConversationHeader
              membersTooltip={tooltip(registry, "members.toggle")}
              onToggleMembers={() => run("members.toggle")}
              onToggleSidebar={() => run("sidebar.toggle")}
              sidebarTooltip={tooltip(registry, "sidebar.toggle")}
              title={activeBuffer()?.title ?? ""}
              topic={activeBuffer()?.topic ?? undefined}
            />
            <div class={styles.conversationBody}>
              <MessageList
                bufferId={activeBuffer()?.id}
                messages={props.messages.get(activeBuffer()?.id ?? -1) ?? []}
                memberships={
                  props.memberships.get(activeBuffer()?.id ?? -1) ?? []
                }
                onLiveEdgeChange={setAtLiveEdge}
                readThrough={activeBuffer()?.read_through}
                registerController={(controller) => {
                  messageListController = controller;
                }}
              />
              <Composer
                bufferId={activeBuffer()?.id ?? 0}
                bufferTitle={activeBuffer()?.title ?? ""}
                candidates={composerCandidates(
                  props.messages.get(activeBuffer()?.id ?? -1) ?? [],
                )}
                disabled={activeBuffer()?.kind === "server"}
                onSend={(text) => {
                  const buffer = activeBuffer();
                  if (buffer !== undefined) props.onSend(buffer.id, text);
                }}
              />
            </div>
          </section>
        ) : (
          <section class={styles.empty}>
            <p>Connect to a network to begin.</p>
          </section>
        )}
      </main>
    </div>
  );
}

function latestCommitted(
  messages: readonly MessageProjection[],
): MessageProjection | undefined {
  return [...messages]
    .reverse()
    .find(
      (message) =>
        message.delivery === "received" || message.delivery === "confirmed",
    );
}

function composerCandidates(messages: readonly MessageProjection[]): string[] {
  const recent = [...messages].reverse().map((message) => message.author);
  return [...new Set(recent)];
}

function orderedBufferIds(
  networks: readonly NetworkProjection[],
  buffers: readonly BufferProjection[],
): number[] {
  const networkOrder = new Map(
    networks.map((network, index) => [network.id, index]),
  );
  return [...buffers]
    .sort(
      (first, second) =>
        (networkOrder.get(first.network_id) ?? Number.MAX_SAFE_INTEGER) -
          (networkOrder.get(second.network_id) ?? Number.MAX_SAFE_INTEGER) ||
        kindOrder(first) - kindOrder(second),
    )
    .map((buffer) => buffer.id);
}

function preferredInitialBuffer(
  buffers: readonly BufferProjection[],
): BufferProjection | undefined {
  return (
    buffers.find((buffer) => buffer.kind === "channel") ??
    buffers.find((buffer) => buffer.kind === "direct") ??
    buffers[0]
  );
}

function kindOrder(buffer: BufferProjection): number {
  if (buffer.kind === "server") return 0;
  if (buffer.kind === "channel") return 1;
  return 2;
}

function tooltip(registry: CommandRegistry, id: CommandId): string {
  const binding = registry.bindingLabel(id);
  return binding === undefined
    ? registry.title(id)
    : `${registry.title(id)} (${binding})`;
}
