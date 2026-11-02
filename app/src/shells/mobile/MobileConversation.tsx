import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  connectionPresentation,
  connectionStateKind,
} from "../../engine/connection-state";
import type {
  BufferProjection,
  CommandSpec,
  CompletionResult,
  MembershipProjection,
  MessageProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { Composer } from "../../features/composer/Composer";
import { t } from "../../features/composer/strings";
import {
  DirectIdentityBanner,
  directIdentityBlocked,
} from "../../features/conversation/DirectIdentityBanner";
import {
  MessageList,
  type MessageListController,
} from "../../features/conversation/MessageList";
import { ConnectionErrorStrip } from "../../ui/ConnectionErrorStrip";
import { Line } from "../../ui/Line";
import { Selectable } from "../../ui/Selectable";
import styles from "./MobileShell.module.css";

export interface MobileConversationProps {
  readonly buffer: BufferProjection;
  readonly hydrating?: boolean | undefined;
  readonly composerNotice?: string | undefined;
  readonly commandSpecs?: readonly CommandSpec[] | undefined;
  readonly completion?: CompletionResult;
  readonly messages: readonly MessageProjection[];
  readonly memberships: readonly MembershipProjection[];
  readonly network?: NetworkProjection | undefined;
  readonly onBack: () => void;
  readonly onLoadHistory: (bufferId: number) => void;
  readonly onMarkRead: (bufferId: number, through: number) => void;
  readonly onMarkCachedRead?: ((bufferId: number) => void) | undefined;
  readonly onOpenMembers: () => void;
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
  readonly onSend: (bufferId: number, text: string) => Promise<boolean>;
}

export function MobileConversation(props: MobileConversationProps) {
  const [atLiveEdge, setAtLiveEdge] = createSignal(false);
  const [foreground, setForeground] = createSignal(
    document.visibilityState === "visible" && document.hasFocus(),
  );
  let listController: MessageListController | undefined;
  const connection = () =>
    connectionPresentation(
      props.network === undefined ? [] : [props.network],
      props.hydrating,
    );

  createEffect(() => {
    const latest = [...props.messages]
      .reverse()
      .find(
        (message) =>
          message.delivery === "received" || message.delivery === "confirmed",
      );
    if (
      props.buffer.unread === 0 ||
      latest === undefined ||
      !atLiveEdge() ||
      !foreground()
    ) {
      return;
    }
    const timeout = window.setTimeout(
      () => props.onMarkRead(props.buffer.id, latest.id),
      500,
    );
    onCleanup(() => window.clearTimeout(timeout));
  });

  let historyRequested = false;
  createEffect(() => {
    if (
      historyRequested ||
      props.buffer.cached === true ||
      props.buffer.available === false
    )
      return;
    historyRequested = true;
    props.onLoadHistory(props.buffer.id);
  });

  onMount(() => {
    const updateForeground = () =>
      setForeground(
        document.visibilityState === "visible" && document.hasFocus(),
      );
    document.addEventListener("visibilitychange", updateForeground);
    window.addEventListener("focus", updateForeground);
    window.addEventListener("blur", updateForeground);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", updateForeground);
      window.removeEventListener("focus", updateForeground);
      window.removeEventListener("blur", updateForeground);
    });
  });

  return (
    <section
      class={styles.chat}
      data-mobile-chat={props.buffer.id}
      data-network-state={
        props.network === undefined
          ? undefined
          : connectionStateKind(props.network.state)
      }
    >
      <header class={styles.chatHeader}>
        <button
          aria-label="Back to chats"
          class={styles.back}
          onClick={() => props.onBack()}
          type="button"
        >
          <span aria-hidden="true">‹</span>
        </button>
        <span class={styles.chatIdentity}>
          <h2>
            <Line>{props.buffer.title}</Line>
          </h2>
          <Line class={styles.subtitle}>
            {props.buffer.kind === "direct" ? (
              "Direct message"
            ) : (
              <Selectable surfaceId="mobile-conversation-topic">
                {props.buffer.topic || "Channel"}
              </Selectable>
            )}
          </Line>
        </span>
        {props.buffer.cached === true && props.buffer.unread > 0 ? (
          <button
            aria-label="Mark as read"
            class={styles.members}
            onClick={() => props.onMarkCachedRead?.(props.buffer.id)}
            title="Mark as read"
            type="button"
          >
            <span aria-hidden="true">✓</span>
          </button>
        ) : props.buffer.kind === "channel" ? (
          <button
            aria-label="Show members"
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
      <div class={styles.conversation}>
        <Show
          when={props.buffer.available !== false}
          fallback={
            <div role="status">
              <p>This conversation is not available.</p>
              {props.composerNotice !== undefined && (
                <p class={styles.notice}>{props.composerNotice}</p>
              )}
              <button onClick={props.onBack} type="button">
                Back to Chats
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
            messages={props.messages}
            memberships={props.memberships}
            onLiveEdgeChange={setAtLiveEdge}
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
            presentation="mobile"
            readAtMs={props.buffer.read_at_ms}
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
            onSend={(text) => props.onSend(props.buffer.id, text)}
          />
        </Show>
      </div>
    </section>
  );
}
