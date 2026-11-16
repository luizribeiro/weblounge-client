import { createMemo, Show } from "solid-js";
import { bufferSyncPresentation } from "../../engine/buffer-sync";
import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { Composer } from "../../features/composer/Composer";
import { ConversationHeader } from "../../features/conversation/ConversationHeader";
import {
  DirectIdentityBanner,
  directIdentityBlocked,
} from "../../features/conversation/DirectIdentityBanner";
import {
  MessageList,
  type MessageListController,
} from "../../features/conversation/MessageList";
import { bufferReactionToggle } from "../../features/conversation/reaction-target";
import { bufferRedaction } from "../../features/conversation/redact-target";
import { t } from "../../strings";
import styles from "./DesktopPane.module.css";
import type { DesktopShellProps } from "./DesktopShell";

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
  | "timelines"
  | "typers"
  | "uploadsFor"
>;

export interface DesktopPaneProps extends SharedShellProps {
  readonly buffer: BufferProjection | undefined;
  readonly network: NetworkProjection | undefined;
  readonly focusComposerOnMount: boolean;
  readonly membersPressed: boolean;
  readonly membersTooltip: string;
  readonly sidebarTooltip: string;
  readonly onLiveEdgeChange: (atLiveEdge: boolean) => void;
  readonly onOpenDirect: (nick: string) => void;
  readonly onSendText: (
    buffer: BufferProjection,
    text: string,
  ) => Promise<boolean>;
  readonly onToggleMembers: () => void;
  readonly onToggleSidebar: () => void;
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
  return (
    <section class={styles.conversation} data-buffer-title={buffer().title}>
      <ConversationHeader
        memberCount={
          buffer().kind === "channel" ? (buffer().member_count ?? 0) : undefined
        }
        membersPressed={props.membersPressed}
        membersTooltip={props.membersTooltip}
        onToggleMembers={() => props.onToggleMembers()}
        onToggleSidebar={() => props.onToggleSidebar()}
        sidebarTooltip={props.sidebarTooltip}
        sync={sync}
        title={buffer().title}
        topic={buffer().topic ?? undefined}
      />
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
    </section>
  );
}

interface PaneComposerProps extends DesktopPaneProps {
  readonly bufferId: number;
  readonly onSelectLast: () => void;
}

function PaneComposer(props: PaneComposerProps) {
  const buffer = () =>
    props.buffer?.id === props.bufferId ? props.buffer : undefined;
  return (
    <Composer
      bufferId={props.bufferId}
      bufferKind={buffer()?.kind}
      bufferTitle={buffer()?.title ?? ""}
      commandSpecs={props.commandSpecs}
      draftKey={buffer()?.draft_key ?? ""}
      completion={
        props.completion?.buffer_id === props.bufferId
          ? props.completion
          : undefined
      }
      disabled={composerDisabled(buffer())}
      focusOnMount={props.focusComposerOnMount}
      typers={props.typers?.get(props.bufferId)}
      uploads={
        props.network === undefined
          ? undefined
          : props.uploadsFor?.(props.network)
      }
      onRequestCandidates={(input, cursor, explicit) =>
        props.onRequestCompletion(props.bufferId, input, cursor, explicit)
      }
      onSelectLast={props.onSelectLast}
      onSend={(text) => {
        const current = buffer();
        return current === undefined
          ? Promise.resolve(false)
          : props.onSendText(current, text);
      }}
    />
  );
}

function composerDisabled(buffer: BufferProjection | undefined): boolean {
  return (
    buffer?.kind === "server" ||
    buffer?.channel_status === "kicked" ||
    buffer?.available === false ||
    (buffer !== undefined && directIdentityBlocked(buffer))
  );
}
