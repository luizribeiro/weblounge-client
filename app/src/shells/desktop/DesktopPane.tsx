import { createMemo, onCleanup, onMount, Show } from "solid-js";
import { bufferSyncPresentation } from "../../engine/buffer-sync";
import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { ConversationHeader } from "../../features/conversation/ConversationHeader";
import { DirectIdentityBanner } from "../../features/conversation/DirectIdentityBanner";
import {
  MessageList,
  type MessageListController,
} from "../../features/conversation/MessageList";
import { bufferReactionToggle } from "../../features/conversation/reaction-target";
import { bufferRedaction } from "../../features/conversation/redact-target";
import {
  MemberPanel,
  type MemberPanelChrome,
  type MemberWindow,
} from "../../features/members/MemberPanel";
import { t } from "../../strings";
import { OverlayDrawer } from "../../ui/OverlayDrawer";
import styles from "./DesktopPane.module.css";
import type { DesktopShellProps } from "./DesktopShell";
import { focusComposerIn } from "./focus-composer";
import { PaneComposer } from "./PaneComposer";
import {
  createPaneMembers,
  memberColumnWidthToken,
  memberWindowFor,
  observePaneWidth,
  type PaneMembersController,
} from "./pane-members";

type SharedShellProps = Pick<
  DesktopShellProps,
  | "commandSpecs"
  | "completion"
  | "composerNotice"
  | "foreground"
  | "foregroundExitEpoch"
  | "historyStates"
  | "memberships"
  | "messageFailureNotices"
  | "messages"
  | "onDeferDirectIdentity"
  | "onLoadHistory"
  | "onRedactMessage"
  | "onRequestCompletion"
  | "onRetry"
  | "onToggleReaction"
  | "onTrustDirectIdentity"
  | "showMemberModeSymbols"
  | "timelines"
  | "typers"
  | "uploadsFor"
>;

export interface DesktopPaneProps extends SharedShellProps {
  readonly buffer: BufferProjection | undefined;
  readonly network: NetworkProjection | undefined;
  readonly focusComposerOnMount: boolean;
  readonly memberWindow: MemberWindow | undefined;
  readonly membersShown: boolean;
  readonly membersTooltip: string;
  readonly sidebarTooltip: string;
  readonly onLiveEdgeChange: (atLiveEdge: boolean) => void;
  readonly onMembersDrawerOpen: () => void;
  readonly onOpenDirect: (nick: string) => void;
  readonly onSendText: (
    buffer: BufferProjection,
    text: string,
  ) => Promise<boolean>;
  readonly onRequestMemberRange: (bufferId: number, offset: number) => void;
  readonly onToggleMembers: () => void;
  readonly onToggleMembersShown: () => void;
  readonly onToggleSidebar: () => void;
  readonly registerMembers: (
    controller: PaneMembersController | undefined,
  ) => void;
  readonly registerMessageList: (controller: MessageListController) => void;
}

export function DesktopPane(props: DesktopPaneProps) {
  return (
    <Show
      when={props.buffer !== undefined}
      fallback={
        <section class={styles.empty}>
          <p>{t("shell.connect_to_begin")}</p>
        </section>
      }
    >
      <PaneConversation {...props} />
    </Show>
  );
}

function PaneConversation(props: DesktopPaneProps) {
  const buffer = () => props.buffer as BufferProjection;
  const composerNotice = createMemo(
    () => props.messageFailureNotices?.get(buffer().id) ?? props.composerNotice,
  );
  const sync = createMemo(() =>
    bufferSyncPresentation(buffer(), props.network),
  );
  const toggleReaction = createMemo(() =>
    bufferReactionToggle(buffer().id, props.network, props.onToggleReaction),
  );
  const redactMessage = createMemo(() =>
    bufferRedaction(buffer().id, props.network, props.onRedactMessage),
  );
  const send = (text: string) => props.onSendText(buffer(), text);
  let messageList: MessageListController | undefined;
  let pane: HTMLElement | undefined;
  const focusComposer = () => focusComposerIn(() => pane);
  const members = createPaneMembers({
    bufferKind: () => props.buffer?.kind,
    focusComposer,
    onDrawerOpen: () => props.onMembersDrawerOpen(),
    onToggleShown: () => props.onToggleMembersShown(),
    shown: () => props.membersShown,
  });
  props.registerMembers(members.controller);
  onCleanup(() => props.registerMembers(undefined));
  onMount(() => {
    const width = pane?.getBoundingClientRect().width ?? 0;
    if (width > 0) members.setWidth(width);
  });
  const MembersOf = (list: {
    readonly bufferId: number;
    readonly chrome: MemberPanelChrome;
    readonly onOpenDirect: (nick: string) => void;
  }) => (
    <MemberPanel
      {...list.chrome}
      bufferTitle={buffer().title}
      onOpenDirect={list.onOpenDirect}
      onRequestRange={(offset) =>
        props.onRequestMemberRange(list.bufferId, offset)
      }
      showModeSymbols={props.showMemberModeSymbols}
      window={memberWindowFor(props.memberWindow, list.bufferId)}
    />
  );
  return (
    <section
      class={styles.conversation}
      data-buffer-title={buffer().title}
      data-desktop-pane="true"
      ref={(element) => {
        pane = element;
        onCleanup(observePaneWidth(element, members.setWidth));
      }}
    >
      <ConversationHeader
        memberCount={
          buffer().kind === "channel" ? (buffer().member_count ?? 0) : undefined
        }
        membersPressed={members.pressed()}
        membersTooltip={props.membersTooltip}
        onToggleMembers={() => props.onToggleMembers()}
        onToggleSidebar={() => props.onToggleSidebar()}
        sidebarTooltip={props.sidebarTooltip}
        sync={sync}
        title={buffer().title}
        topic={buffer().topic ?? undefined}
      />
      <div
        class={styles.paneBody}
        data-members-inline={members.inlineShown() ? "true" : undefined}
      >
        <div class={styles.conversationBody}>
          {buffer().available === false && (
            <p role="status">{t("shell.conversation_unavailable")}</p>
          )}
          <DirectIdentityBanner
            buffer={buffer()}
            onDefer={(bufferId) => props.onDeferDirectIdentity?.(bufferId)}
            onTrust={(bufferId) => props.onTrustDirectIdentity?.(bufferId)}
          />
          <MessageList
            bufferId={buffer().id}
            bufferKind={buffer().kind}
            bufferTitle={buffer().title}
            channelStatus={buffer().channel_status}
            filehostOrigin={props.network?.filehost_origin}
            foregroundExitEpoch={props.foregroundExitEpoch}
            messages={props.messages.get(buffer().id) ?? []}
            timeline={props.timelines?.get(buffer().id)}
            timelineEnabled={props.timelines !== undefined}
            foreground={props.foreground !== false}
            memberships={props.memberships.get(buffer().id) ?? []}
            historyState={props.historyStates?.get(buffer().id)}
            onLiveEdgeChange={props.onLiveEdgeChange}
            onLoadOlder={() => props.onLoadHistory(buffer().id, "older")}
            onOpenChannel={(channel) => void send(`/join ${channel}`)}
            onOpenDirect={
              buffer().kind === "server" ? undefined : props.onOpenDirect
            }
            onRejoin={() => void send(`/join ${buffer().title}`)}
            onRetry={(localSendId) => props.onRetry?.(buffer().id, localSendId)}
            onToggleReaction={toggleReaction()}
            onRedactMessage={redactMessage()}
            readAtMs={buffer().read_at_ms}
            unread={buffer().unread}
            syncState={buffer().sync_state}
            registerController={(controller) => {
              messageList = controller;
              props.registerMessageList(controller);
            }}
          />
          {composerNotice() !== undefined && (
            <p class={styles.notice} role="status">
              {composerNotice()}
            </p>
          )}
          {buffer().channel_status === "kicked" && (
            <p class={styles.notice} role="status">
              {t("engine.channel_rejoin_required", { target: buffer().title })}
            </p>
          )}
          <Show when={buffer().id} keyed>
            {(bufferId) => (
              <PaneComposer
                {...props}
                bufferId={bufferId}
                onSelectLast={() => messageList?.selectLastOwn()}
              />
            )}
          </Show>
        </div>
        <Show when={members.inlineShown() ? buffer().id : undefined} keyed>
          {(bufferId) => (
            <MembersOf
              bufferId={bufferId}
              chrome={{ header: "none", onEscape: focusComposer }}
              onOpenDirect={props.onOpenDirect}
            />
          )}
        </Show>
      </div>
      <Show when={members.drawerShown()}>
        <OverlayDrawer
          closeLabel={t("members.close_drawer")}
          closing={members.drawerClosing()}
          edge="right"
          label={t("members.label")}
          onClose={() => members.closeDrawer()}
          scrim="clear"
          width={memberColumnWidthToken}
        >
          {(requestClose) => (
            <div class={styles.drawerContent}>
              <MembersOf
                bufferId={buffer().id}
                chrome={{ onClose: requestClose }}
                onOpenDirect={(nick) => {
                  props.onOpenDirect(nick);
                  members.closeDrawer();
                }}
              />
            </div>
          )}
        </OverlayDrawer>
      </Show>
    </section>
  );
}
