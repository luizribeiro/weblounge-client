import type {
  BufferProjection,
  CommandSpec,
  CompletionResult,
  MembershipProjection,
  MessageProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { MobileChatList } from "./MobileChatList";
import { MobileConversation } from "./MobileConversation";
import styles from "./MobileShell.module.css";
import type { ChatFilter } from "./mobile-chats";
import type {
  MobileTransition,
  MobileScreen as Screen,
} from "./mobile-navigation";

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
  readonly onRequestCompletion: (
    bufferId: number,
    input: string,
    cursor: number,
    explicit: boolean,
  ) => void;
  readonly onSend: (bufferId: number, text: string) => Promise<boolean>;
}

interface MobileScreenProps extends MobileShellData {
  readonly filter: ChatFilter;
  readonly position?: "from" | "to" | undefined;
  readonly query: string;
  readonly screen: Screen;
  readonly scrollTop: number;
  readonly swipe?: "chat" | "chats" | undefined;
  readonly swipeProgress?: number | undefined;
  readonly swipeReturning?: boolean | undefined;
  readonly transition?: MobileTransition["direction"] | undefined;
  readonly onBack: () => void;
  readonly onFilter: (filter: ChatFilter) => void;
  readonly onOpen: (bufferId: number) => void;
  readonly onQuery: (query: string) => void;
  readonly onScroll: (scrollTop: number) => void;
  readonly onSwipeReturnEnd: () => void;
  readonly onTransitionEnd: () => void;
}

export function MobileScreen(props: MobileScreenProps) {
  const buffer = () => {
    const screen = props.screen;
    return screen.kind === "chat"
      ? props.buffers.find((item) => item.id === screen.bufferId)
      : undefined;
  };
  return (
    <div
      class={styles.screen}
      data-position={props.position}
      data-swipe={props.swipe}
      data-swipe-returning={props.swipeReturning}
      data-transition={props.transition}
      onAnimationEnd={props.onTransitionEnd}
      onTransitionEnd={props.onSwipeReturnEnd}
      style={{ "--wl-swipe-progress": props.swipeProgress }}
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
          scrollTop={props.scrollTop}
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
          onRequestCompletion={props.onRequestCompletion}
          onRetryNetwork={props.onRetryNetwork}
          onSend={props.onSend}
        />
      ) : null}
    </div>
  );
}
