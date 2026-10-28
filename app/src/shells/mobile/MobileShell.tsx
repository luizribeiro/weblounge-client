import { createEffect, createSignal, For, onCleanup, onMount } from "solid-js";
import { MobileScreen, type MobileShellData } from "./MobileScreen";
import styles from "./MobileShell.module.css";
import type { ChatFilter } from "./mobile-chats";
import {
  createMobileStack,
  finishTransition,
  mountedScreens,
  popChat,
  pushChat,
  swipeBackCompletes,
} from "./mobile-navigation";

interface MobileShellProps extends MobileShellData {
  readonly focusRequest?: { readonly bufferId: number } | undefined;
  readonly initialBufferId?: number | undefined;
  readonly onSelectBuffer: (bufferId: number) => void;
}

export function MobileShell(props: MobileShellProps) {
  const reducedMotion = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const initial = createMobileStack();
  const [stack, setStack] = createSignal(
    props.initialBufferId === undefined
      ? initial
      : pushChat(initial, props.initialBufferId, true),
  );
  const [filter, setFilter] = createSignal<ChatFilter>("all");
  const [query, setQuery] = createSignal("");
  const [scrollTop, setScrollTop] = createSignal(0);
  const [swipeProgress, setSwipeProgress] = createSignal<number>();
  let gesture:
    | { pointerId: number; startX: number; startedAt: number; width: number }
    | undefined;

  const open = (bufferId: number) => {
    props.onSelectBuffer(bufferId);
    window.history.pushState(
      { ...historyState(), webloungeMobileChat: true },
      "",
    );
    setStack((current) => pushChat(current, bufferId, reducedMotion()));
  };
  const dispatchBack = () =>
    setStack((current) => popChat(current, reducedMotion()));
  const requestBack = () => {
    if (window.history.state?.webloungeMobileChat === true) {
      window.history.back();
    } else {
      dispatchBack();
    }
  };

  createEffect(() => {
    const requested = props.focusRequest?.bufferId;
    const active = stack().active;
    if (
      requested !== undefined &&
      (active.kind !== "chat" || requested !== active.bufferId)
    ) {
      open(requested);
    }
  });

  const beginSwipe = (event: PointerEvent) => {
    const target = event.target as Element;
    if (
      event.clientX > 24 ||
      stack().active.kind !== "chat" ||
      stack().transition !== undefined ||
      target.closest(
        "[data-selectable], input, textarea, [data-horizontal-scroll]",
      ) !== null
    )
      return;
    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startedAt: event.timeStamp,
      width:
        event.currentTarget instanceof Element
          ? event.currentTarget.getBoundingClientRect().width
          : window.innerWidth,
    };
    setSwipeProgress(0);
  };
  const moveSwipe = (event: PointerEvent) => {
    if (gesture?.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientX - gesture.startX);
    setSwipeProgress(Math.min(1, distance / gesture.width));
  };
  const endSwipe = (event: PointerEvent) => {
    if (gesture?.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientX - gesture.startX);
    const velocity =
      distance / Math.max(1, event.timeStamp - gesture.startedAt);
    const completes = swipeBackCompletes(distance, gesture.width, velocity);
    gesture = undefined;
    setSwipeProgress(undefined);
    if (completes) requestBack();
  };
  const screens = () =>
    swipeProgress() === undefined
      ? mountedScreens(stack())
      : [{ kind: "chats" } as const, stack().active];

  onMount(() => {
    const handlePopState = () => dispatchBack();
    window.addEventListener("popstate", handlePopState);
    onCleanup(() => window.removeEventListener("popstate", handlePopState));
  });

  return (
    <main
      class={styles.shell}
      data-mobile-shell="true"
      onPointerCancel={endSwipe}
      onPointerDown={beginSwipe}
      onPointerMove={moveSwipe}
      onPointerUp={endSwipe}
    >
      <For each={screens()}>
        {(screen, index) => {
          const transition = () => stack().transition;
          return (
            <MobileScreen
              buffers={props.buffers}
              composerNotice={props.composerNotice}
              completion={props.completion}
              filter={filter()}
              memberships={props.memberships}
              messages={props.messages}
              networks={props.networks}
              onBack={requestBack}
              onFilter={setFilter}
              onLoadHistory={props.onLoadHistory}
              onMarkRead={props.onMarkRead}
              onOpen={open}
              onQuery={setQuery}
              onRequestCompletion={props.onRequestCompletion}
              onScroll={setScrollTop}
              onSend={props.onSend}
              onTransitionEnd={() => setStack(finishTransition)}
              position={
                transition() === undefined
                  ? undefined
                  : index() === 0
                    ? "from"
                    : "to"
              }
              query={query()}
              screen={screen}
              scrollTop={scrollTop()}
              swipe={
                swipeProgress() === undefined
                  ? undefined
                  : screen.kind === "chat"
                    ? "chat"
                    : "chats"
              }
              swipeProgress={swipeProgress()}
              transition={transition()?.direction}
            />
          );
        }}
      </For>
    </main>
  );
}

function historyState(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null
    ? (state as Record<string, unknown>)
    : {};
}
