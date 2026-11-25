import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { bufferSyncPresentation } from "../../engine/buffer-sync";
import {
  connectionPresentation,
  connectionStateKind,
} from "../../engine/connection-state";
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
import { Composer } from "../../features/composer/Composer";
import type { ReplyDrafts } from "../../features/composer/reply-drafts";
import { ConversationTitle } from "../../features/conversation/ConversationTitle";
import {
  DirectIdentityBanner,
  directIdentityBlocked,
} from "../../features/conversation/DirectIdentityBanner";
import { DirectPresence } from "../../features/conversation/DirectPresence";
import {
  MessageList,
  type MessageListController,
} from "../../features/conversation/MessageList";
import { presenceStatus } from "../../features/conversation/presence-status";
import {
  bufferReactionToggle,
  reactionTarget,
  type ToggleBufferReaction,
} from "../../features/conversation/reaction-target";
import {
  bufferRedaction,
  canRedact,
  type RedactBufferMessage,
} from "../../features/conversation/redact-target";
import {
  bufferReply,
  replyTarget,
} from "../../features/conversation/reply-target";
import {
  createReadDwell,
  newestCommittedMessageId,
  newestCommittedTimelineMessageId,
} from "../../features/unread/createReadDwell";
import type { NetworkUploads } from "../../features/uploads/types";
import { t } from "../../strings";
import { ConnectionErrorStrip } from "../../ui/ConnectionErrorStrip";
import { copyText } from "../../ui/copy-text";
import { Line } from "../../ui/Line";
import type { SendText } from "../send-text";
import { MobileMessageActionSheet } from "./MobileMessageActionSheet";
import styles from "./MobileShell.module.css";
import { messageSheetActions } from "./message-sheet-actions";

export interface MobileConversationProps {
  readonly buffer: BufferProjection;
  readonly foreground?: boolean | undefined;
  readonly foregroundExitEpoch?: number | undefined;
  readonly composerNotice?: string | undefined;
  readonly commandSpecs?: readonly CommandSpec[] | undefined;
  readonly completion?: CompletionResult | undefined;
  readonly messages: readonly MessageProjection[];
  readonly timeline?: TimelineView | undefined;
  readonly timelineEnabled?: boolean | undefined;
  readonly memberships: readonly MembershipProjection[];
  readonly historyState?: HistoryState | undefined;
  readonly typers?: readonly TypingProjection[] | undefined;
  readonly network?: NetworkProjection | undefined;
  readonly uploadsFor?:
    | ((network: NetworkProjection) => NetworkUploads | undefined)
    | undefined;
  readonly onBack: () => void;
  readonly onLoadHistory: (
    bufferId: number,
    direction: HistoryDirection,
  ) => void;
  readonly onMarkRead: (bufferId: number, through: number) => void;
  readonly onOpenMembers: () => void;
  readonly onOpenDetails?: (() => void) | undefined;
  readonly onOpenDirect?: ((nick: string) => void) | undefined;
  readonly onDeferDirectIdentity?: ((bufferId: number) => void) | undefined;
  readonly onTrustDirectIdentity?: ((bufferId: number) => void) | undefined;
  readonly onRequestCompletion: (
    bufferId: number,
    input: string,
    cursor: number,
    explicit: boolean,
  ) => void;
  readonly onRetryNetwork?: ((networkId: number) => void) | undefined;
  readonly showConnectionError?: boolean | undefined;
  readonly onRetry?:
    | ((bufferId: number, localSendId: number) => void)
    | undefined;
  readonly onSend: SendText;
  readonly replyDrafts?: ReplyDrafts | undefined;
  readonly onToggleReaction?: ToggleBufferReaction | undefined;
  readonly onRedactMessage?: RedactBufferMessage | undefined;
  readonly visible?: boolean | undefined;
}

export function MobileConversation(props: MobileConversationProps) {
  const [atLiveEdge, setAtLiveEdge] = createSignal(false);
  let listController: MessageListController | undefined;
  const connection = () =>
    connectionPresentation(props.network === undefined ? [] : [props.network]);
  const sync = () => bufferSyncPresentation(props.buffer, props.network);
  const bufferId = createMemo(() => props.buffer.id);
  const [heldMessage, setHeldMessage] = createSignal<MessageProjection>();
  let focusBeforeActions: Element | null = null;
  const openMessageActions = (message: MessageProjection) => {
    if (heldMessage() === undefined)
      focusBeforeActions = document.activeElement;
    setHeldMessage(message);
  };
  const dismissMessageActions = () => {
    setHeldMessage(undefined);
    if (
      focusBeforeActions instanceof HTMLElement &&
      focusBeforeActions.isConnected
    )
      focusBeforeActions.focus({ preventScroll: true });
    focusBeforeActions = null;
  };
  // Dismissing the sheet hands focus back to where it was, so whatever takes focus next (the
  // delete confirmation, the composer for a reply) must run after that.
  const afterSheetCloses = (run: () => void) => () => queueMicrotask(run);
  const toggleReaction = createMemo(() =>
    bufferReactionToggle(
      props.buffer.id,
      props.network,
      props.onToggleReaction,
    ),
  );
  const redactMessage = createMemo(() =>
    bufferRedaction(props.buffer.id, props.network, props.onRedactMessage),
  );
  const replyMessage = createMemo(() =>
    bufferReply(props.buffer.id, props.network, props.replyDrafts?.start),
  );

  const newestMessageId = createMemo(() =>
    props.timeline === undefined
      ? newestCommittedMessageId(props.messages)
      : newestCommittedTimelineMessageId(props.timeline.items),
  );
  const readDwelling = createReadDwell({
    atLiveEdge,
    bufferId,
    foreground: () => props.foreground !== false,
    foregroundExitEpoch: () => props.foregroundExitEpoch,
    newestCommittedMessageId: newestMessageId,
    onMarkRead: (currentBufferId, through) =>
      props.onMarkRead(currentBufferId, through),
    visible: () => props.visible !== false,
  });

  let historyRequested = false;
  createEffect(() => {
    if (historyRequested || props.buffer.available === false) return;
    historyRequested = true;
    props.onLoadHistory(props.buffer.id, "latest");
  });

  return (
    <section
      class={styles.chat}
      data-mobile-chat={props.buffer.id}
      data-read-dwell={readDwelling() ? "" : undefined}
      data-network-state={
        props.network === undefined
          ? undefined
          : connectionStateKind(props.network.state)
      }
    >
      <header class={styles.chatHeader}>
        <button
          aria-label={t("mobile.back_to_chats")}
          class={styles.back}
          onClick={() => props.onBack()}
          type="button"
        >
          <span aria-hidden="true">‹</span>
        </button>
        <button
          aria-label={identityLabel(props.buffer)}
          class={styles.chatIdentity}
          disabled={
            props.buffer.kind !== "channel" || props.onOpenDetails === undefined
          }
          onClick={props.onOpenDetails}
          type="button"
        >
          <ConversationTitle sync={sync} title={props.buffer.title} />
          <DirectPresence
            bot={props.buffer.peer_bot === true}
            class={styles.subtitle}
            fallback={
              <Line class={styles.subtitle}>
                {props.buffer.kind === "direct"
                  ? t("mobile.conversation.direct")
                  : props.buffer.kind === "server"
                    ? t("mobile.conversation.server")
                    : props.buffer.topic || t("mobile.conversation.channel")}
              </Line>
            }
            presence={
              props.buffer.kind === "direct"
                ? props.buffer.peer_presence
                : undefined
            }
            sinceMs={props.buffer.peer_presence_since_ms}
          />
        </button>
        {props.buffer.kind === "channel" ? (
          <button
            aria-label={t("mobile.show_members")}
            class={styles.members}
            onClick={props.onOpenMembers}
            type="button"
          >
            <svg
              aria-hidden="true"
              fill="none"
              height="20"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="1.8"
              viewBox="0 0 24 24"
              width="20"
            >
              <path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1" />
              <circle cx="9.5" cy="8" r="3.5" />
              <path d="M21 19v-1a4 4 0 0 0-3-3.87M16 4.13a4 4 0 0 1 0 7.75" />
            </svg>
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
      </header>
      <Show
        when={props.showConnectionError !== false && connection().error}
        keyed
      >
        {(error) => (
          <ConnectionErrorStrip
            error={error}
            onAction={(networkId) => props.onRetryNetwork?.(networkId)}
          />
        )}
      </Show>
      <div class={styles.conversation} data-composer-scope="true">
        <Show
          when={props.buffer.available !== false}
          fallback={
            <div role="status">
              <p>{t("shell.conversation_unavailable")}</p>
              {props.composerNotice !== undefined && (
                <p class={styles.notice}>{props.composerNotice}</p>
              )}
              <button onClick={props.onBack} type="button">
                {t("mobile.back_to_chats_action")}
              </button>
            </div>
          }
        >
          <DirectIdentityBanner
            buffer={props.buffer}
            onDefer={(bufferId) => props.onDeferDirectIdentity?.(bufferId)}
            onTrust={(bufferId) => props.onTrustDirectIdentity?.(bufferId)}
          />
          <MessageList
            bufferId={props.buffer.id}
            bufferKind={props.buffer.kind}
            bufferTitle={props.buffer.title}
            channelStatus={props.buffer.channel_status}
            filehostOrigin={props.network?.filehost_origin}
            foregroundExitEpoch={props.foregroundExitEpoch}
            messages={props.messages}
            timeline={props.timeline}
            timelineEnabled={props.timelineEnabled}
            foreground={props.foreground !== false}
            memberships={props.memberships}
            historyState={props.historyState}
            onLiveEdgeChange={setAtLiveEdge}
            onLoadOlder={() => props.onLoadHistory(props.buffer.id, "older")}
            onGapShown={() => props.onLoadHistory(props.buffer.id, "gap")}
            onOpenChannel={(channel) => {
              void props.onSend(props.buffer.id, `/join ${channel}`);
            }}
            onOpenDirect={
              props.buffer.kind === "server" ? undefined : props.onOpenDirect
            }
            onRejoin={() =>
              void props.onSend(props.buffer.id, `/join ${props.buffer.title}`)
            }
            onRetry={(localSendId) =>
              props.onRetry?.(props.buffer.id, localSendId)
            }
            onToggleReaction={toggleReaction()}
            onRedactMessage={redactMessage()}
            onReplyMessage={replyMessage()}
            replyingTo={props.replyDrafts?.draft(props.buffer.id)?.messageId}
            onMessageActions={openMessageActions}
            heldMessageId={heldMessage()?.id}
            presentation="mobile"
            readAtMs={props.buffer.read_at_ms}
            syncState={props.buffer.sync_state}
            unread={props.buffer.unread}
            registerController={(controller) => {
              listController = controller;
            }}
          />
          {props.composerNotice !== undefined && (
            <p class={styles.notice} role="status">
              {props.composerNotice}
            </p>
          )}
          {props.buffer.channel_status === "kicked" && (
            <p class={styles.notice} role="status">
              {t("engine.channel_rejoin_required", {
                target: props.buffer.title,
              })}
            </p>
          )}
          <Composer
            bufferId={props.buffer.id}
            bufferKind={props.buffer.kind}
            bufferTitle={props.buffer.title}
            commandSpecs={props.commandSpecs}
            draftKey={props.buffer.draft_key}
            completion={
              props.completion?.buffer_id === props.buffer.id
                ? props.completion
                : undefined
            }
            onRequestCandidates={(input, cursor, explicit) =>
              props.onRequestCompletion(
                props.buffer.id,
                input,
                cursor,
                explicit,
              )
            }
            onSelectLast={() => listController?.selectLastOwn()}
            disabled={
              props.buffer.channel_status === "kicked" ||
              directIdentityBlocked(props.buffer)
            }
            onCancelReply={(reply) =>
              props.replyDrafts?.cancel(props.buffer.id, reply)
            }
            onSend={(text, replyTo) =>
              props.onSend(props.buffer.id, text, replyTo)
            }
            reply={props.replyDrafts?.draft(props.buffer.id)}
            typers={props.typers}
            uploads={
              props.network === undefined
                ? undefined
                : props.uploadsFor?.(props.network)
            }
          />
        </Show>
      </div>
      <Show when={heldMessage()} keyed>
        {(message) => {
          const reply = replyTarget(message, replyMessage());
          return (
            <MobileMessageActionSheet
              actions={messageSheetActions(message, {
                copyText,
                reply:
                  reply === undefined ? undefined : afterSheetCloses(reply),
                delete: canRedact(message, redactMessage())
                  ? afterSheetCloses(() =>
                      listController?.confirmDelete(message.id),
                    )
                  : undefined,
              })}
              message={message}
              onDismiss={dismissMessageActions}
              onReact={reactionTarget(message, toggleReaction())}
            />
          );
        }}
      </Show>
    </section>
  );
}

function identityLabel(buffer: BufferProjection): string {
  return buffer.kind === "direct" && buffer.peer_presence !== undefined
    ? t("mobile.direct_status", {
        title: buffer.title,
        status: presenceStatus(
          buffer.peer_presence,
          buffer.peer_presence_since_ms,
        ),
      })
    : t("mobile.show_details", { title: buffer.title });
}
