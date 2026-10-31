import { type Accessor, createEffect, on } from "solid-js";
import type {
  BufferProjection,
  CommandSpec,
  CompletionResult,
  MembershipProjection,
  MessageProjection,
  NetworkProjection,
} from "../../engine/protocol";
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

export interface MobileShellData {
  readonly networks: readonly NetworkProjection[];
  readonly buffers: readonly BufferProjection[];
  readonly commandSpecs?: readonly CommandSpec[] | undefined;
  readonly composerNotice: string | undefined;
  readonly completion: CompletionResult | undefined;
  readonly messages: ReadonlyMap<number, readonly MessageProjection[]>;
  readonly memberships: ReadonlyMap<number, readonly MembershipProjection[]>;
  readonly onLoadHistory: (bufferId: number) => void;
  readonly onMarkRead: (bufferId: number, through: number) => void;
  readonly onRetryNetwork?: ((networkId: number) => void) | undefined;
  readonly onOpenMembers?: ((bufferId: number) => void) | undefined;
  readonly onOpenDirect?:
    | ((networkId: number, nick: string) => void)
    | undefined;
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
  return (
    <div
      aria-hidden={props.retained || undefined}
      class={styles.screen}
      data-retained={props.retained || undefined}
      inert={props.retained ?? false}
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
          networks={props.networks}
          onFilter={props.onFilter}
          onOpen={props.onOpen}
          onQuery={props.onQuery}
          onRetryNetwork={props.onRetryNetwork}
          onScroll={props.onScroll}
          query={props.query}
          restoreScroll={() => props.chatsScrollTop() ?? 0}
          restoreVersion={props.chatsScrollVersion}
        />
      ) : buffer() !== undefined ? (
        <MobileConversation
          buffer={buffer() as BufferProjection}
          commandSpecs={props.commandSpecs}
          {...(props.composerNotice === undefined
            ? {}
            : { composerNotice: props.composerNotice })}
          {...(props.completion === undefined
            ? {}
            : { completion: props.completion })}
          memberships={props.memberships.get(buffer()?.id ?? -1) ?? []}
          messages={props.messages.get(buffer()?.id ?? -1) ?? []}
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
          onRequestCompletion={props.onRequestCompletion}
          onRetryNetwork={props.onRetryNetwork}
          onRetry={props.onRetry}
          onSend={props.onSend}
        />
      ) : null}
    </div>
  );
}
