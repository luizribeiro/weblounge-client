import { createSignal, For, onCleanup, onMount } from "solid-js";
import { MobileScreen, type MobileShellData } from "./MobileScreen";
import styles from "./MobileShell.module.css";
import type { ChatFilter } from "./mobile-chats";
import {
  createMobileStack,
  finishTransition,
  mountedScreens,
  popChat,
  pushChat,
} from "./mobile-navigation";

interface MobileShellProps extends MobileShellData {
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

  onMount(() => {
    const handlePopState = () => dispatchBack();
    window.addEventListener("popstate", handlePopState);
    onCleanup(() => window.removeEventListener("popstate", handlePopState));
  });

  return (
    <main class={styles.shell} data-mobile-shell="true">
      <For each={mountedScreens(stack())}>
        {(screen, index) => {
          const transition = () => stack().transition;
          return (
            <MobileScreen
              buffers={props.buffers}
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
              transition={transition()?.direction}
              {...(props.composerNotice === undefined
                ? {}
                : { composerNotice: props.composerNotice })}
              {...(props.completion === undefined
                ? {}
                : { completion: props.completion })}
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
