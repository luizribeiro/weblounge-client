import { type Accessor, createEffect, on } from "solid-js";
import type {
  BufferProjection,
  CommandSpec,
  CompletionResult,
  MembershipProjection,
  MessageProjection,
  NetworkProjection,
  TypingProjection,
} from "../../engine/protocol";
import type { NotificationPromptControls } from "../../features/notifications/NotificationPrompt";
import { movingTransform } from "../../ui/transform-motion";
import { MobileChatList } from "./MobileChatList";
import { MobileConversation } from "./MobileConversation";
import styles from "./MobileShell.module.css";
import type { ChatFilter } from "./mobile-chats";
import type { MobileScreen as Screen } from "./mobile-navigation";
import {
  type PushMotion,
  pushOffset,
  settlesByTransition,
} from "./push-motion";

export interface MobileShellData extends NotificationPromptControls {
  readonly networks: readonly NetworkProjection[];
  readonly buffers: readonly BufferProjection[];
  readonly hydrating?: boolean | undefined;
  readonly commandSpecs?: readonly CommandSpec[] | undefined;
  readonly composerNotice: string | undefined;
  readonly messageFailureNotices?: ReadonlyMap<number, string> | undefined;
  readonly completion: CompletionResult | undefined;
  readonly messages: ReadonlyMap<number, readonly MessageProjection[]>;
  readonly memberships: ReadonlyMap<number, readonly MembershipProjection[]>;
  readonly typers?:
    | ReadonlyMap<number, readonly TypingProjection[]>
    | undefined;
  readonly onLoadHistory: (bufferId: number) => void;
  readonly onMarkRead: (bufferId: number, through: number) => void;
  readonly onRetryNetwork?: ((networkId: number) => void) | undefined;
  readonly onOpenMembers?: ((bufferId: number) => void) | undefined;
  readonly onOpenDirect?:
    | ((networkId: number, nick: string) => void)
    | undefined;
  readonly onDeferDirectIdentity?: ((bufferId: number) => void) | undefined;
  readonly onTrustDirectIdentity?: ((bufferId: number) => void) | undefined;
  readonly onRequestCompletion: (
    bufferId: number,
    input: string,
    cursor: number,
    explicit: boolean,
  ) => void;
  readonly onSend: (bufferId: number, text: string) => Promise<boolean>;
  readonly onRetry?:
    | ((bufferId: number, localSendId: number) => void)
    | undefined;
}

interface MobileScreenProps extends MobileShellData {
  readonly chatsScrollTop: Accessor<number | undefined>;
  readonly chatsScrollVersion: Accessor<number>;
  readonly filter: ChatFilter;
  readonly motion?: PushMotion | undefined;
  readonly inactive?: boolean | undefined;
  readonly query: string;
  readonly retained?: boolean | undefined;
  readonly screen: Screen;
  readonly onBack: () => void;
  readonly onFilter: (filter: ChatFilter) => void;
  readonly onOpen: (bufferId: number, scrollTop: number) => void;
  readonly onQuery: (query: string) => void;
  readonly onScroll: (scrollTop: number) => void;
  readonly onMotionEnd: () => void;
}

export function MobileScreen(props: MobileScreenProps) {
  let element: HTMLDivElement | undefined;
  const settleUnlessMoving = () => {
    if (!movingTransform(element)) props.onMotionEnd();
  };
  const settleSoon = () => queueMicrotask(settleUnlessMoving);
  const onOwnTransform = (handler: () => void) => (event: TransitionEvent) => {
    if (event.target === element && event.propertyName === "transform")
      handler();
  };
  createEffect(
    on(
      () => props.motion?.phase,
      (phase) => {
        if (phase !== undefined && settlesByTransition(phase)) settleSoon();
      },
    ),
  );
  const buffer = () => {
    const screen = props.screen;
    return screen.kind === "chat"
      ? props.buffers.find((item) => item.id === screen.bufferId)
      : undefined;
  };
  const composerNotice = () =>
    props.messageFailureNotices?.get(buffer()?.id ?? -1) ??
    props.composerNotice;
  return (
    <div
      aria-hidden={props.inactive || props.retained || undefined}
      class={styles.screen}
      data-retained={props.retained || undefined}
      inert={props.inactive || props.retained || false}
      data-motion={props.motion?.phase}
      onTransitionCancel={onOwnTransform(settleSoon)}
      onTransitionEnd={onOwnTransform(settleUnlessMoving)}
      ref={element}
      style={{
        "--wl-push-offset":
          props.motion === undefined ? undefined : pushOffset(props.motion),
        "--wl-push-settle-scale":
          props.motion !== undefined && "durationScale" in props.motion
            ? props.motion.durationScale
            : undefined,
      }}
    >
      {props.screen.kind === "chats" ? (
        <MobileChatList
          buffers={props.buffers}
          filter={props.filter}
          hydrating={props.hydrating}
          networks={props.networks}
          notificationPromptVisible={props.notificationPromptVisible}
          onDismissNotificationPrompt={props.onDismissNotificationPrompt}
          onFilter={props.onFilter}
          onOpen={props.onOpen}
          onQuery={props.onQuery}
          onRetryNetwork={props.onRetryNetwork}
          onTurnOnNotifications={props.onTurnOnNotifications}
          showConnectionError={!props.retained}
          onScroll={props.onScroll}
          query={props.query}
          restoreScroll={() => props.chatsScrollTop() ?? 0}
          restoreVersion={props.chatsScrollVersion}
        />
      ) : buffer() !== undefined ? (
        <MobileConversation
          buffer={buffer() as BufferProjection}
          hydrating={props.hydrating}
          commandSpecs={props.commandSpecs}
          composerNotice={composerNotice()}
          {...(props.completion === undefined
            ? {}
            : { completion: props.completion })}
          memberships={props.memberships.get(buffer()?.id ?? -1) ?? []}
          messages={props.messages.get(buffer()?.id ?? -1) ?? []}
          typers={props.typers?.get(buffer()?.id ?? -1) ?? []}
          network={props.networks.find(
            (network) => network.id === buffer()?.network_id,
          )}
          onBack={props.onBack}
          onLoadHistory={props.onLoadHistory}
          onMarkRead={props.onMarkRead}
          onOpenMembers={() => props.onOpenMembers?.(buffer()?.id ?? 0)}
          onOpenDirect={(nick) =>
            props.onOpenDirect?.(buffer()?.network_id ?? 0, nick)
          }
          onDeferDirectIdentity={props.onDeferDirectIdentity}
          onTrustDirectIdentity={props.onTrustDirectIdentity}
          onRequestCompletion={props.onRequestCompletion}
          onRetryNetwork={props.onRetryNetwork}
          showConnectionError={!props.retained}
          onRetry={props.onRetry}
          onSend={props.onSend}
          visible={!props.inactive && !props.retained}
        />
      ) : null}
    </div>
  );
}
