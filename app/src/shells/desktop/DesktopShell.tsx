import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  type ActionContext,
  type ActionId,
  ActionRegistry,
  jumpActionId,
  jumpSlots,
  type UiActionId,
} from "../../actions/action-registry";
import { listenForShellActions } from "../../actions/shell-actions";
import type { SettingChange } from "../../engine/generated/SettingChange";
import type { Settings } from "../../engine/generated/Settings";
import type {
  BufferProjection,
  CommandSpec,
  CompletionResult,
  HistoryDirection,
  HistoryState,
  MembershipProjection,
  MessageProjection,
  NetworkProjection,
  TypingProjection,
} from "../../engine/protocol";
import type { TimelineView } from "../../engine/timeline-store";
import type { MessageListController } from "../../features/conversation/MessageList";
import type { ToggleBufferReaction } from "../../features/conversation/reaction-target";
import type { RedactBufferMessage } from "../../features/conversation/redact-target";
import type { MemberWindow } from "../../features/members/MemberPanel";
import type { NotificationPromptControls } from "../../features/notifications/NotificationPrompt";
import { SettingsModal } from "../../features/settings/SettingsModal";
import {
  Sidebar,
  type SidebarListController,
} from "../../features/sidebar/Sidebar";
import { focusAfterClose } from "../../features/sidebar/sidebar-close";
import {
  conversationRowIds,
  sidebarRowIds,
  wrappedNeighbourId,
} from "../../features/sidebar/sidebar-order";
import { sidebarWidthToken } from "../../features/sidebar/sidebar-width";
import { BufferSwitcher } from "../../features/switcher/BufferSwitcher";
import {
  createReadDwell,
  newestCommittedMessageId,
  newestCommittedTimelineMessageId,
} from "../../features/unread/createReadDwell";
import type { NetworkUploads } from "../../features/uploads/types";
import {
  channelKey,
  membersShown,
  toggleMembers,
} from "../../navigation/member-visibility";
import {
  readMemberVisibility,
  writeMemberVisibility,
} from "../../navigation/member-visibility-storage";
import { platformEnvironment } from "../../platform/environment";
import { translate } from "../../strings";
import { returnFocus } from "../../ui/focus-return";
import { OverlayDrawer } from "../../ui/OverlayDrawer";
import { DesktopPane } from "./DesktopPane";
import styles from "./DesktopShell.module.css";
import { focusComposerIn } from "./focus-composer";
import { createSinglePane, showInFocusedPane } from "./pane-layout";
import type { PaneMembersController } from "./pane-members";

export interface DesktopShellProps extends NotificationPromptControls {
  readonly networks: readonly NetworkProjection[];
  readonly uploadsFor?:
    | ((network: NetworkProjection) => NetworkUploads | undefined)
    | undefined;
  readonly buffers: readonly BufferProjection[];
  readonly commandSpecs?: readonly CommandSpec[] | undefined;
  readonly composerNotice: string | undefined;
  readonly messageFailureNotices?: ReadonlyMap<number, string> | undefined;
  readonly completion: CompletionResult | undefined;
  readonly focusRequest: { readonly bufferId: number } | undefined;
  readonly foreground?: boolean | undefined;
  readonly foregroundExitEpoch?: number | undefined;
  readonly onFocusRequestHandled?:
    | ((request: { readonly bufferId: number }) => void)
    | undefined;
  readonly messages: ReadonlyMap<number, readonly MessageProjection[]>;
  readonly timelines?: ReadonlyMap<number, TimelineView> | undefined;
  readonly memberships: ReadonlyMap<number, readonly MembershipProjection[]>;
  readonly historyStates?: ReadonlyMap<number, HistoryState> | undefined;
  readonly typers?:
    | ReadonlyMap<number, readonly TypingProjection[]>
    | undefined;
  readonly memberWindows?: ReadonlyMap<string, MemberWindow> | undefined;
  readonly memberViewScope?: string | undefined;
  readonly showMemberModeSymbols?: boolean | undefined;
  readonly activeBufferId?: number | undefined;
  readonly onFocusedBufferChange?:
    | ((bufferId: number | undefined) => void)
    | undefined;
  readonly bufferRemoval?:
    | {
        readonly bufferId: number;
        readonly previousBufferId: number | undefined;
      }
    | undefined;
  readonly onSelectBuffer?: ((bufferId: number) => void) | undefined;
  readonly pathForBuffer?:
    | ((bufferId: number) => string | undefined)
    | undefined;
  readonly onSend: (bufferId: number, text: string) => Promise<boolean>;
  readonly onMarkRead: (bufferId: number, through: number) => void;
  readonly onLoadHistory: (
    bufferId: number,
    direction: HistoryDirection,
  ) => void;
  readonly onRequestCompletion: (
    bufferId: number,
    input: string,
    cursor: number,
    explicit: boolean,
  ) => void;
  readonly onRequestMembers?:
    | ((
        viewId: string,
        bufferId: number,
        offset: number,
        filter?: string,
      ) => void)
    | undefined;
  readonly onOpenDirect?:
    | ((networkId: number, nick: string) => void)
    | undefined;
  readonly onDeferDirectIdentity?: ((bufferId: number) => void) | undefined;
  readonly onTrustDirectIdentity?: ((bufferId: number) => void) | undefined;
  readonly onRetryNetwork?: ((networkId: number) => void) | undefined;
  readonly onRetry?:
    | ((bufferId: number, localSendId: number) => void)
    | undefined;
  readonly onToggleReaction?: ToggleBufferReaction | undefined;
  readonly onRedactMessage?: RedactBufferMessage | undefined;
  readonly settings?: Settings | undefined;
  readonly onChangeSetting?: ((change: SettingChange) => void) | undefined;
}

export function DesktopShell(props: DesktopShellProps) {
  const platform = platformEnvironment();
  const memberViewScope = props.memberViewScope ?? crypto.randomUUID();
  const [layout, setLayout] = createSignal(
    createSinglePane(props.activeBufferId),
  );
  const [sidebarShown, setSidebarShown] = createSignal(true);
  const [memberVisibility, setMemberVisibility] = createSignal(
    readMemberVisibility(),
  );
  const [omnibarMode, setOmnibarMode] = createSignal<
    "buffers" | "commands" | null
  >(null);
  const [recentActionIds, setRecentActionIds] = createSignal<
    readonly ActionId[]
  >([]);
  const [recentBufferIds, setRecentBufferIds] = createSignal<readonly number[]>(
    [],
  );
  const [closedConversation, setClosedConversation] = createSignal<{
    readonly id: number;
    readonly networkId: number;
    readonly title: string;
  }>();
  const [retainSidebarFocus, setRetainSidebarFocus] = createSignal(false);
  const [drawer, setDrawer] = createSignal<"sidebar" | null>(null);
  const [atLiveEdge, setAtLiveEdge] = createSignal(false);
  let listController: SidebarListController | undefined;
  let messageListController: MessageListController | undefined;
  let shellElement: HTMLDivElement | undefined;
  let paneMembers: PaneMembersController | undefined;
  let closeUndoTimer: number | undefined;
  const requestedHistory = new Set<number>();
  const activeBuffer = createMemo(() =>
    props.buffers.find((buffer) => buffer.id === layout().root.bufferId),
  );
  const activeBufferId = createMemo(() => activeBuffer()?.id);
  const jumpTargets = createMemo(() =>
    conversationRowIds(props.networks, props.buffers),
  );
  createEffect(() => props.onFocusedBufferChange?.(activeBufferId()));
  createEffect(() => {
    const bufferId = activeBufferId();
    if (bufferId === undefined) return;
    setRecentBufferIds((current) =>
      current[0] === bufferId
        ? current
        : [bufferId, ...current.filter((id) => id !== bufferId)],
    );
  });
  const activeNetwork = createMemo(() => {
    const networkId = activeBuffer()?.network_id;
    return props.networks.find((network) => network.id === networkId);
  });
  const newestMessageIds = createMemo(() => {
    const messages = props.messages;
    const timelines = props.timelines;
    return new Map(
      props.buffers.map((buffer) => {
        const timeline = timelines?.get(buffer.id);
        const newest =
          timeline === undefined
            ? newestCommittedMessageId(messages.get(buffer.id) ?? [])
            : newestCommittedTimelineMessageId(timeline.items);
        return [buffer.id, newest] as const;
      }),
    );
  });
  const newestMessageId = createMemo(() =>
    newestMessageIds().get(activeBufferId() ?? -1),
  );
  const visibleBufferIds = createMemo<ReadonlySet<number>>(() => {
    const buffer = activeBuffer();
    return new Set(buffer === undefined ? [] : [buffer.id]);
  });
  const memberViewId = () => `${memberViewScope}:desktop:${layout().root.id}`;
  const activeChannelKey = () => {
    const buffer = activeBuffer();
    return buffer === undefined ? undefined : channelKey(buffer);
  };
  const activeMembersShown = () => {
    const key = activeChannelKey();
    return key !== undefined && membersShown(memberVisibility(), key);
  };
  const toggleActiveMembers = () => {
    const key = activeChannelKey();
    if (key === undefined) return;
    const next = toggleMembers(memberVisibility(), key);
    setMemberVisibility(next);
    writeMemberVisibility(next);
  };
  const memberWindow = () => props.memberWindows?.get(memberViewId());
  const sidebarInline = () => platform.environment().desktopPanels === "inline";
  const focusComposer = () => focusComposerIn(() => shellElement);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  let settingsInvoker: Element | null = null;
  const openSettings = () => {
    if (settingsOpen()) return;
    settingsInvoker = document.activeElement;
    setOmnibarMode(null);
    setSettingsOpen(true);
  };
  const closeSettings = () => {
    setSettingsOpen(false);
    const invoker = settingsInvoker;
    settingsInvoker = null;
    queueMicrotask(() => {
      if (!returnFocus(invoker)) focusComposer();
    });
  };
  const closeDrawer = (restoreFocus = true) => {
    setDrawer(null);
    if (restoreFocus) focusComposer();
  };
  const context = (): ActionContext => {
    const currentBufferKind = activeBuffer()?.kind;
    return {
      bufferCount: props.buffers.length,
      conversationCount: jumpTargets().length,
      connected: props.networks.some(
        (network) =>
          network.id === activeBuffer()?.network_id &&
          network.state === "online",
      ),
      ...(currentBufferKind === undefined ? {} : { currentBufferKind }),
      listActive: (sidebarShown() && sidebarInline()) || drawer() === "sidebar",
    };
  };
  const showBuffer = (bufferId: number | undefined) => {
    if (bufferId !== undefined) {
      setLayout((current) => showInFocusedPane(current, bufferId));
      props.onSelectBuffer?.(bufferId);
      if (drawer() === "sidebar") closeDrawer();
      const path = props.pathForBuffer?.(bufferId);
      if (path !== undefined)
        window.history.replaceState(window.history.state, "", path);
    }
  };
  const dismissCloseUndo = () => {
    if (closeUndoTimer !== undefined) window.clearTimeout(closeUndoTimer);
    closeUndoTimer = undefined;
    setClosedConversation(undefined);
  };
  const closeDirect = async (
    buffer: BufferProjection,
    nextBufferId = focusAfterClose(
      sidebarRowIds(props.networks, props.buffers),
      buffer.id,
    ),
    retainFocus = false,
  ): Promise<boolean> => {
    if (!(await props.onSend(buffer.id, "/close"))) return false;
    setRetainSidebarFocus(retainFocus);
    showBuffer(nextBufferId);
    if (retainFocus) queueMicrotask(() => setRetainSidebarFocus(false));
    setClosedConversation({
      id: buffer.id,
      networkId: buffer.network_id,
      title: buffer.title,
    });
    if (closeUndoTimer !== undefined) window.clearTimeout(closeUndoTimer);
    closeUndoTimer = window.setTimeout(dismissCloseUndo, 6_000);
    return true;
  };
  const undoClose = () => {
    const closed = closedConversation();
    if (closed === undefined) return;
    dismissCloseUndo();
    props.onOpenDirect?.(closed.networkId, closed.title);
  };
  const moveBuffer = (offset: -1 | 1) => {
    const ids = sidebarRowIds(props.networks, props.buffers);
    const current = layout().root.bufferId;
    if (ids.length < 2 || current === undefined) return;
    showBuffer(wrappedNeighbourId(ids, current, offset));
  };
  const registry = new ActionRegistry(
    {
      "buffer.mark-read": (command) => {
        const bufferId = command.targetBufferId;
        const through = newestMessageIds().get(bufferId ?? -1);
        if (bufferId !== undefined && through !== undefined)
          props.onMarkRead(bufferId, through);
      },
      ...Object.fromEntries(
        jumpSlots.map((slot) => [
          jumpActionId(slot),
          () => showBuffer(jumpTargets()[slot - 1]),
        ]),
      ),
      "buffer.next": () => moveBuffer(1),
      "buffer.open": () => {},
      "buffer.open-direct": (command) => {
        if (
          command.targetNetworkId === undefined ||
          command.targetNick === undefined
        )
          return;
        props.onOpenDirect?.(command.targetNetworkId, command.targetNick);
        focusComposer();
      },
      "buffer.previous": () => moveBuffer(-1),
      "list.next": () => listController?.next(),
      "list.open": () => listController?.open(),
      "list.previous": () => listController?.previous(),
      "members.toggle": () => paneMembers?.toggle(),
      "message.jump-bottom": () => messageListController?.jumpBottom(),
      "network.open-server": (command) => showBuffer(command.targetBufferId),
      "pane.show-buffer": (command) => showBuffer(command.targetBufferId),
      "sidebar.toggle": () => {
        if (sidebarInline()) {
          setSidebarShown((shown) => !shown);
          setDrawer(null);
          return;
        }
        setSidebarShown(true);
        if (drawer() === "sidebar") closeDrawer();
        else {
          paneMembers?.dismissDrawer();
          setDrawer("sidebar");
        }
      },
      "palette.open": () => setOmnibarMode("commands"),
      "settings.open": () => openSettings(),
      "switcher.open": () => setOmnibarMode("buffers"),
    },
    platform.shortcutPlatform,
    props.commandSpecs ?? [],
    (command, commandContext) => {
      const bufferId = commandContext.targetBufferId ?? activeBufferId();
      const buffer = props.buffers.find((item) => item.id === bufferId);
      if (command.name === "close" && buffer?.kind === "direct") {
        void closeDirect(buffer);
      } else if (bufferId !== undefined) {
        void props.onSend(bufferId, `/${command.name}`);
      }
    },
    platform.shortcutShell === "native" ? "tauri" : "web",
  );
  createEffect(() => registry.updateCommands(props.commandSpecs ?? []));
  const run = (id: UiActionId) => registry.run(id, context());
  const runPaletteAction = (id: ActionId): boolean => {
    let result = registry.run(id, context(), "menu");
    if (result === "confirmation_required") {
      const command = registry
        .palette(context())
        .find((entry) => entry.id === id)?.command;
      if (
        command?.confirmation_prompt === undefined ||
        !window.confirm(
          translate(command.confirmation_prompt, {
            text: activeBuffer()?.title,
          }),
        )
      ) {
        return false;
      }
      result = registry.run(id, context(), "menu", true);
    }
    if (result !== "ran") return false;
    setRecentActionIds((current) => [
      id,
      ...current.filter((recentId) => recentId !== id),
    ]);
    return true;
  };
  const openDirect = (nick: string) => {
    const buffer = activeBuffer();
    if (buffer === undefined || buffer.kind === "server") return;
    registry.run("buffer.open-direct", {
      ...context(),
      targetNetworkId: buffer.network_id,
      targetNick: nick,
    });
  };

  createEffect(
    on(
      () => props.activeBufferId,
      (activeBufferId) => {
        if (
          activeBufferId !== undefined &&
          activeBufferId !== activeBuffer()?.id
        ) {
          setLayout((current) => showInFocusedPane(current, activeBufferId));
        }
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const current = drawer();
    if (current === "sidebar" && sidebarInline()) closeDrawer();
  });

  createReadDwell({
    atLiveEdge,
    bufferId: activeBufferId,
    foreground: () => props.foreground !== false,
    foregroundExitEpoch: () => props.foregroundExitEpoch,
    newestCommittedMessageId: newestMessageId,
    onMarkRead: (bufferId, through) => props.onMarkRead(bufferId, through),
    visible: () => true,
  });

  createEffect(() => {
    const request = props.focusRequest;
    if (request === undefined) return;
    showBuffer(request.bufferId);
    props.onFocusRequestHandled?.(request);
  });

  createEffect(() => {
    const buffer = activeBuffer();
    if (
      buffer === undefined ||
      buffer.kind === "server" ||
      buffer.available === false ||
      requestedHistory.has(buffer.id)
    ) {
      return;
    }
    requestedHistory.add(buffer.id);
    props.onLoadHistory(buffer.id, "latest");
  });

  createEffect(() => {
    if (layout().root.bufferId !== undefined) return;
    const preferred = preferredInitialBuffer(props.buffers);
    if (preferred !== undefined)
      setLayout((current) => showInFocusedPane(current, preferred.id));
  });

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (settingsOpen()) return;
      if (
        closedConversation() !== undefined &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLocaleLowerCase() === "z" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        undoClose();
        return;
      }
      if (registry.handleKeydown(event, context())) return;
      forwardPrintableKey(event, shellElement);
    };
    document.addEventListener("keydown", handleKeydown);
    onCleanup(
      listenForShellActions(window, (action) =>
        registry.run(action, context()),
      ),
    );
    onCleanup(() => {
      if (closeUndoTimer !== undefined) window.clearTimeout(closeUndoTimer);
      document.removeEventListener("keydown", handleKeydown);
    });
  });

  return (
    <div class={styles.shell} data-desktop-shell="true" ref={shellElement}>
      {sidebarShown() && sidebarInline() && sidebarView()}
      <main
        class={styles.main}
        data-chromeless={sidebarShown() && sidebarInline() ? "false" : "true"}
      >
        <DesktopPane
          buffer={activeBuffer()}
          commandSpecs={props.commandSpecs}
          completion={props.completion}
          composerNotice={props.composerNotice}
          focusComposerOnMount={!retainSidebarFocus()}
          foreground={props.foreground}
          foregroundExitEpoch={props.foregroundExitEpoch}
          historyStates={props.historyStates}
          memberships={props.memberships}
          memberWindow={memberWindow()}
          membersShown={activeMembersShown()}
          membersTooltip={tooltip(registry, "members.toggle")}
          messageFailureNotices={props.messageFailureNotices}
          messages={props.messages}
          network={activeNetwork()}
          onDeferDirectIdentity={props.onDeferDirectIdentity}
          onLiveEdgeChange={setAtLiveEdge}
          onMembersDrawerOpen={() => {
            if (drawer() === "sidebar") setDrawer(null);
          }}
          onLoadHistory={props.onLoadHistory}
          onOpenDirect={openDirect}
          onRedactMessage={props.onRedactMessage}
          onRequestCompletion={props.onRequestCompletion}
          onRetry={props.onRetry}
          onSendText={(buffer, text) =>
            buffer.kind === "direct" && /^\/(?:close|wc)\s*$/iu.test(text)
              ? closeDirect(buffer)
              : props.onSend(buffer.id, text)
          }
          onRequestMemberRange={(bufferId, offset) =>
            props.onRequestMembers?.(memberViewId(), bufferId, offset)
          }
          onToggleMembers={() => run("members.toggle")}
          onToggleMembersShown={toggleActiveMembers}
          onToggleReaction={props.onToggleReaction}
          onToggleSidebar={() => run("sidebar.toggle")}
          onTrustDirectIdentity={props.onTrustDirectIdentity}
          registerMembers={(controller) => {
            paneMembers = controller;
          }}
          registerMessageList={(controller) => {
            messageListController = controller;
          }}
          showMemberModeSymbols={props.showMemberModeSymbols}
          sidebarTooltip={tooltip(registry, "sidebar.toggle")}
          timelines={props.timelines}
          typers={props.typers}
          uploadsFor={props.uploadsFor}
        />
      </main>
      <Show when={settingsOpen()}>
        <SettingsModal
          onChange={(change) => props.onChangeSetting?.(change)}
          onClose={closeSettings}
          rail={platform.environment().desktopPanels === "overlay"}
          settings={props.settings?.app}
        />
      </Show>
      <Show when={omnibarMode()} keyed>
        {(initialMode) => (
          <BufferSwitcher
            actions={registry.palette(context())}
            buffers={props.buffers}
            initialMode={initialMode}
            networks={props.networks}
            onDismiss={() => setOmnibarMode(null)}
            onOpen={(bufferId) => {
              setOmnibarMode(null);
              showBuffer(bufferId);
            }}
            onRunAction={runPaletteAction}
            recentActionIds={recentActionIds()}
            recentBufferIds={recentBufferIds()}
          />
        )}
      </Show>
      {drawer() === "sidebar" && !sidebarInline() && (
        <OverlayDrawer
          closeLabel="Close channel list"
          edge="left"
          label="Channels"
          onClose={closeDrawer}
          width={sidebarWidthToken}
        >
          {sidebarView()}
        </OverlayDrawer>
      )}
    </div>
  );

  function sidebarView() {
    return (
      <Sidebar
        activeBufferId={activeBuffer()?.id}
        buffers={props.buffers}
        commandContext={context()}
        networks={props.networks}
        notificationPromptVisible={props.notificationPromptVisible}
        onDismissNotificationPrompt={props.onDismissNotificationPrompt}
        onCloseDirect={(buffer, nextBufferId) =>
          closeDirect(buffer, nextBufferId, true)
        }
        onRetryNetwork={props.onRetryNetwork}
        onTurnOnNotifications={props.onTurnOnNotifications}
        registerListController={(controller) => {
          listController = controller;
        }}
        registry={registry}
        closedConversation={
          closedConversation() === undefined
            ? undefined
            : { title: closedConversation()?.title ?? "", onUndo: undoClose }
        }
        visibleBufferIds={visibleBufferIds()}
      />
    );
  }
}

function forwardPrintableKey(
  event: KeyboardEvent,
  shell: HTMLElement | undefined,
): void {
  if (
    shell === undefined ||
    event.defaultPrevented ||
    event.isComposing ||
    event.getModifierState("AltGraph") ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    Array.from(event.key).length !== 1 ||
    document.querySelector('[role="dialog"], dialog[open]') !== null
  ) {
    return;
  }
  const target = event.target;
  if (target instanceof Element) {
    if (isEditable(target)) return;
    if (
      event.key === " " &&
      target.closest("button, a, summary, [role='button']") !== null
    ) {
      return;
    }
  }
  const composer = shell.querySelector<HTMLTextAreaElement>(
    "[data-composer] textarea:not(:disabled)",
  );
  if (composer === null) return;
  event.preventDefault();
  composer.focus({ preventScroll: true });
  composer.setRangeText(
    event.key,
    composer.selectionStart,
    composer.selectionEnd,
    "end",
  );
  composer.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      data: event.key,
      inputType: "insertText",
    }),
  );
}

function isEditable(target: Element): boolean {
  return (
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
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

function tooltip(registry: ActionRegistry, id: UiActionId): string {
  const binding = registry.bindingLabel(id);
  return binding === undefined
    ? registry.title(id)
    : `${registry.title(id)} (${binding})`;
}
