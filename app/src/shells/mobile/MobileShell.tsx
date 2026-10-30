import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
} from "solid-js";
import type { MemberWindow } from "../../features/members/MemberPanel";
import { mobileHistoryPolicy } from "../../platform/mobile-history";
import { MobileMemberDrawer } from "./MobileMemberDrawer";
import { MobileScreen, type MobileShellData } from "./MobileScreen";
import styles from "./MobileShell.module.css";
import type { ChatFilter } from "./mobile-chats";
import {
  createMobileStack,
  finishTransition,
  type MobileScreen as MobileScreenState,
  mountedScreens,
  popChat,
  previousScreen,
  pushChat,
  swipeBackCompletes,
} from "./mobile-navigation";
import { type MobileViewport, observeMobileViewport } from "./mobile-viewport";

interface MobileShellProps extends MobileShellData {
  readonly focusRequest?: { readonly bufferId: number } | undefined;
  readonly onFocusRequestHandled?:
    | ((request: { readonly bufferId: number }) => void)
    | undefined;
  readonly initialBufferId?: number | undefined;
  readonly onSelectBuffer: (bufferId: number) => void;
  readonly pathForBuffer?:
    | ((bufferId: number) => string | undefined)
    | undefined;
  readonly memberWindows?: ReadonlyMap<string, MemberWindow> | undefined;
  readonly memberViewScope?: string | undefined;
  readonly onOpenDirect?:
    | ((networkId: number, nick: string) => void)
    | undefined;
  readonly onRequestMembers?:
    | ((
        viewId: string,
        bufferId: number,
        offset: number,
        filter?: string,
      ) => void)
    | undefined;
}

export function MobileShell(props: MobileShellProps) {
  const historyPolicy = mobileHistoryPolicy();
  const memberViewId = `${props.memberViewScope ?? crypto.randomUUID()}:mobile:drawer`;
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
  const [swipeReturning, setSwipeReturning] = createSignal(false);
  const [viewport, setViewport] = createSignal<MobileViewport>();
  const [drawerBufferId, setDrawerBufferId] = createSignal<number>();
  const [memberFilter, setMemberFilter] = createSignal("");
  const drawerBuffer = createMemo(() =>
    props.buffers.find((buffer) => buffer.id === drawerBufferId()),
  );
  let handledFocusRequest: { readonly bufferId: number } | undefined;
  let pendingDirect: { networkId: number; nick: string } | undefined;
  let pendingHistoryPopInstant = false;
  let pushNextFocus = false;
  let gesture:
    | { pointerId: number; startX: number; startedAt: number; width: number }
    | undefined;

  const open = (bufferId: number, preserveCurrent = false) => {
    const state = mobileHistoryState(true, false);
    const path = props.pathForBuffer?.(bufferId);
    if (
      historyPolicy === "stack" &&
      (stack().active.kind === "chats" || preserveCurrent)
    )
      window.history.pushState(state, "", path);
    else window.history.replaceState(state, "", path);
    props.onSelectBuffer(bufferId);
    setStack((current) =>
      pushChat(current, bufferId, reducedMotion(), preserveCurrent),
    );
  };
  const dispatchBack = (instant = reducedMotion()) =>
    setStack((current) => {
      const next = popChat(current, instant);
      if (historyPolicy === "replace") {
        window.history.replaceState(
          mobileHistoryState(next.active.kind === "chat", false),
          "",
          next.active.kind === "chat"
            ? props.pathForBuffer?.(next.active.bufferId)
            : "/",
        );
      }
      return next;
    });
  const resetSwipe = () => {
    gesture = undefined;
    setSwipeReturning(false);
    setSwipeProgress(undefined);
  };
  const resetMotion = () => {
    resetSwipe();
    setStack(finishTransition);
  };
  const finishDrawerClose = () => {
    setDrawerBufferId(undefined);
    if (pendingDirect !== undefined) {
      pushNextFocus = true;
      props.onOpenDirect?.(pendingDirect.networkId, pendingDirect.nick);
      pendingDirect = undefined;
    }
  };
  const closeDrawer = () => {
    if (
      historyPolicy === "stack" &&
      window.history.state?.webloungeMobileDrawer === true
    )
      window.history.back();
    else {
      window.history.replaceState(mobileHistoryState(true, false), "");
      finishDrawerClose();
    }
  };
  const requestBack = (instant = false) => {
    if (drawerBufferId() !== undefined) return closeDrawer();
    if (
      historyPolicy === "stack" &&
      window.history.state?.webloungeMobileChat === true
    ) {
      pendingHistoryPopInstant = instant;
      window.history.back();
    } else {
      dispatchBack(instant || reducedMotion());
    }
  };
  const openMembers = (bufferId: number) => {
    setMemberFilter("");
    setDrawerBufferId(bufferId);
    const state = mobileHistoryState(true, true);
    if (historyPolicy === "stack") window.history.pushState(state, "");
    else window.history.replaceState(state, "");
  };

  createEffect(() => {
    const request = props.focusRequest;
    if (request === undefined || request === handledFocusRequest) return;
    handledFocusRequest = request;
    const requested = request.bufferId;
    const active = stack().active;
    if (active.kind !== "chat" || requested !== active.bufferId) {
      open(requested, pushNextFocus);
    }
    pushNextFocus = false;
    props.onFocusRequestHandled?.(request);
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
  const returnSwipe = () => {
    if (reducedMotion() || swipeProgress() === 0) {
      setSwipeProgress(undefined);
      return;
    }
    setSwipeReturning(true);
    setSwipeProgress(0);
  };
  const endSwipe = (event: PointerEvent) => {
    if (gesture?.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientX - gesture.startX);
    const velocity =
      distance / Math.max(1, event.timeStamp - gesture.startedAt);
    const completes = swipeBackCompletes(distance, gesture.width, velocity);
    gesture = undefined;
    if (completes) {
      setSwipeProgress(undefined);
      requestBack(true);
    } else returnSwipe();
  };
  const cancelSwipe = (event: PointerEvent) => {
    if (gesture?.pointerId !== event.pointerId) return;
    gesture = undefined;
    returnSwipe();
  };
  const screens = () =>
    retainChatsScreen(
      stack(),
      swipeProgress() === undefined
        ? mountedScreens(stack())
        : [previousScreen(stack()), stack().active],
    );
  const screenIsRetained = (screen: MobileScreenState) => {
    const current = stack();
    if (screen.kind !== "chats" || current.active.kind === "chats")
      return false;
    if (swipeProgress() !== undefined)
      return previousScreen(current) !== screen;
    return (
      current.transition?.from !== screen && current.transition?.to !== screen
    );
  };

  onMount(() => {
    const handlePopState = () => {
      if (historyPolicy === "replace") {
        resetMotion();
        return;
      }
      const browserHandledSwipe =
        pendingHistoryPopInstant ||
        gesture !== undefined ||
        swipeProgress() !== undefined;
      pendingHistoryPopInstant = false;
      resetSwipe();
      if (drawerBufferId() === undefined)
        dispatchBack(browserHandledSwipe || reducedMotion());
      else finishDrawerClose();
    };
    const handleVisibilityChange = () => resetMotion();
    window.addEventListener("popstate", handlePopState);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const stopViewport = observeMobileViewport(window, setViewport);
    if (historyPolicy === "replace") {
      window.history.replaceState(
        mobileHistoryState(stack().active.kind === "chat", false),
        "",
      );
    }
    onCleanup(() => {
      stopViewport();
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    });
  });

  return (
    <main
      class={styles.shell}
      data-history-policy={historyPolicy}
      data-mobile-shell="true"
      onPointerCancel={cancelSwipe}
      onPointerDown={beginSwipe}
      onPointerMove={moveSwipe}
      onPointerUp={endSwipe}
      style={{
        "--wl-visual-height":
          viewport() === undefined ? undefined : `${viewport()?.height}px`,
        "--wl-visual-top":
          viewport() === undefined ? undefined : `${viewport()?.offsetTop}px`,
      }}
    >
      <For each={screens()}>
        {(screen, index) => {
          const transition = () => stack().transition;
          return (
            <MobileScreen
              buffers={props.buffers}
              commandSpecs={props.commandSpecs}
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
              onOpenMembers={openMembers}
              onQuery={setQuery}
              onRequestCompletion={props.onRequestCompletion}
              onScroll={setScrollTop}
              onSend={props.onSend}
              onTransitionEnd={() => setStack(finishTransition)}
              onTransitionCancel={resetMotion}
              position={
                transition() === undefined
                  ? undefined
                  : index() === 0
                    ? "from"
                    : "to"
              }
              query={query()}
              retained={screenIsRetained(screen)}
              screen={screen}
              scrollTop={scrollTop()}
              swipe={
                swipeProgress() === undefined
                  ? undefined
                  : screen.kind === "chat"
                    ? "chat"
                    : "chats"
              }
              swipeReturning={swipeReturning() || undefined}
              swipeProgress={swipeProgress()}
              transition={transition()?.direction}
              onSwipeReturnEnd={() => {
                resetSwipe();
              }}
            />
          );
        }}
      </For>
      {drawerBuffer() !== undefined && (
        <MobileMemberDrawer
          bufferTitle={drawerBuffer()?.title ?? ""}
          filter={memberFilter()}
          onClose={closeDrawer}
          onFilter={(filter) => {
            setMemberFilter(filter);
          }}
          onOpenDirect={(nick) => {
            pendingDirect = {
              networkId: drawerBuffer()?.network_id ?? 0,
              nick,
            };
            closeDrawer();
          }}
          onRequestRange={(offset) =>
            props.onRequestMembers?.(
              memberViewId,
              drawerBufferId() ?? 0,
              offset,
              memberFilter(),
            )
          }
          window={props.memberWindows?.get(memberViewId)}
        />
      )}
    </main>
  );
}

function retainChatsScreen(
  stack: ReturnType<typeof createMobileStack>,
  screens: readonly MobileScreenState[],
): readonly MobileScreenState[] {
  const chats =
    stack.active.kind === "chats"
      ? stack.active
      : stack.back.find((screen) => screen.kind === "chats");
  return chats === undefined || screens.includes(chats)
    ? screens
    : [chats, ...screens];
}

function historyState(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null
    ? (state as Record<string, unknown>)
    : {};
}

function mobileHistoryState(
  chat: boolean,
  drawer: boolean,
): Record<string, unknown> {
  const state = { ...historyState() };
  delete state.webloungeMobileChat;
  delete state.webloungeMobileDrawer;
  if (chat) state.webloungeMobileChat = true;
  if (drawer) state.webloungeMobileDrawer = true;
  return state;
}
