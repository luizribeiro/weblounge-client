import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type {
  BufferProjection,
  MembershipProjection,
  MessageProjection,
} from "../../engine/protocol";
import { Composer } from "../../features/composer/Composer";
import {
  MessageList,
  type MessageListController,
} from "../../features/conversation/MessageList";
import { Line } from "../../ui/Line";
import { Selectable } from "../../ui/Selectable";
import styles from "./MobileShell.module.css";

export interface MobileConversationProps {
  readonly buffer: BufferProjection;
  readonly composerNotice?: string | undefined;
  readonly completion?: {
    readonly bufferId: number;
    readonly prefix: string;
    readonly candidates: readonly string[];
  };
  readonly messages: readonly MessageProjection[];
  readonly memberships: readonly MembershipProjection[];
  readonly onBack: () => void;
  readonly onLoadHistory: (bufferId: number) => void;
  readonly onMarkRead: (bufferId: number, through: number) => void;
  readonly onRequestCompletion: (bufferId: number, prefix: string) => void;
  readonly onSend: (bufferId: number, text: string) => Promise<boolean>;
}

export function MobileConversation(props: MobileConversationProps) {
  const [atLiveEdge, setAtLiveEdge] = createSignal(false);
  const [foreground, setForeground] = createSignal(
    document.visibilityState === "visible" && document.hasFocus(),
  );
  let listController: MessageListController | undefined;

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

  onMount(() => {
    props.onLoadHistory(props.buffer.id);
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
    <section class={styles.chat} data-mobile-chat={props.buffer.id}>
      <header class={styles.chatHeader}>
        <button
          aria-label="Back to chats"
          class={styles.back}
          onClick={props.onBack}
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
        <span aria-hidden="true" />
      </header>
      <div class={styles.conversation}>
        <MessageList
          bufferId={props.buffer.id}
          messages={props.messages}
          memberships={props.memberships}
          onLiveEdgeChange={setAtLiveEdge}
          presentation="mobile"
          readThrough={props.buffer.read_through}
          registerController={(controller) => {
            listController = controller;
          }}
        />
        {props.composerNotice !== undefined && (
          <p class={styles.notice} role="status">
            {props.composerNotice}
          </p>
        )}
        <Composer
          bufferId={props.buffer.id}
          bufferTitle={props.buffer.title}
          draftKey={props.buffer.draft_key}
          candidatePrefix={
            props.completion?.bufferId === props.buffer.id
              ? props.completion.prefix
              : undefined
          }
          candidates={
            props.completion?.bufferId === props.buffer.id
              ? props.completion.candidates
              : []
          }
          onRequestCandidates={(prefix) =>
            props.onRequestCompletion(props.buffer.id, prefix)
          }
          onSelectLast={() => listController?.selectLastOwn()}
          onSend={(text) => props.onSend(props.buffer.id, text)}
        />
      </div>
    </section>
  );
}
