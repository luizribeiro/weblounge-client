import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
} from "solid-js";
import type { MemberWindow } from "../../features/members/MemberPanel";
import { platformEnvironment } from "../../platform/environment";
import { mobileHistoryPolicy } from "../../platform/mobile-history";
import { createHorizontalPan } from "../../ui/horizontal-pan";
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
} from "./mobile-navigation";

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
  const platform = platformEnvironment();
  const historyPolicy = mobileHistoryPolicy();
  const reducedMotion = platform.prefersReducedMotion;
  const memberViewId = `${props.memberViewScope ?? crypto.randomUUID()}:mobile:drawer`;
  const initial = createMobileStack();
  const initialBufferId =
    window.location.pathname === "/" ? undefined : props.initialBufferId;
  const [stack, setStack] = createSignal(
    initialBufferId === undefined
      ? initial
      : pushChat(initial, initialBufferId, true),
  );
  const [filter, setFilter] = createSignal<ChatFilter>("all");
  const [query, setQuery] = createSignal("");
  const [scrollRestoreVersion, setScrollRestoreVersion] = createSignal(0);
  const [swipeProgress, setSwipeProgress] = createSignal<number>();
  const [swipeReturning, setSwipeReturning] = createSignal(false);
  const [drawerBufferId, setDrawerBufferId] = createSignal<number>();
  const [memberFilter, setMemberFilter] = createSignal("");
  const [memberOpenProgress, setMemberOpenProgress] = createSignal<number>();
  const [memberOpenReturning, setMemberOpenReturning] = createSignal(false);
  const [drawerHistoryClosing, setDrawerHistoryClosing] = createSignal(false);
  const drawerBuffer = createMemo(() =>
    props.buffers.find((buffer) => buffer.id === drawerBufferId()),
  );
  let handledFocusRequest: { readonly bufferId: number } | undefined;
  let memberOpenBufferId: number | undefined;
  let memberOpenTarget: "closed" | "open" | undefined;
  let pendingDirect: { networkId: number; nick: string } | undefined;
  let drawerCloseAwaitingHistory = false;
  let pendingHistoryPopInstant = false;
  let pushNextFocus = false;
  let suppressCompletedSwipeClick = false;
  let shellElement: HTMLElement | undefined;
  let chatsStable = true;
  let returnScrollTop = 0;

  const open = (
    bufferId: number,
    preserveCurrent = false,
    currentScrollTop?: number,
  ) => {
    if (currentScrollTop !== undefined) {
      returnScrollTop = currentScrollTop;
    }
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
      pushChat(
        current,
        bufferId,
        platform.prefersReducedMotion(),
        preserveCurrent,
      ),
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
  const replaceWithRoot = () => {
    window.history.replaceState(mobileHistoryState(false, false), "", "/");
    setStack((current) => {
      const chats =
        current.active.kind === "chats"
          ? current.active
          : current.back.find((screen) => screen.kind === "chats");
      return { active: chats ?? { kind: "chats" }, back: [] };
    });
  };
  const resetSwipe = () => {
    swipeGesture.reset();
    setSwipeReturning(false);
    setSwipeProgress(undefined);
  };
  const resetMemberOpen = () => {
    memberOpenGesture.reset();
    memberOpenBufferId = undefined;
    memberOpenTarget = undefined;
    setMemberOpenReturning(false);
    setMemberOpenProgress(undefined);
  };
  const resetMotion = () => {
    resetSwipe();
    if (memberOpenTarget === "open") resetMemberOpen();
    else if (memberOpenProgress() !== undefined) {
      resetMemberOpen();
      setDrawerBufferId(undefined);
    }
    setStack(finishTransition);
  };
  const finishDrawerClose = () => {
    resetMemberOpen();
    drawerCloseAwaitingHistory = false;
    setDrawerHistoryClosing(false);
    setDrawerBufferId(undefined);
    if (pendingDirect !== undefined) {
      pushNextFocus = true;
      props.onOpenDirect?.(pendingDirect.networkId, pendingDirect.nick);
      pendingDirect = undefined;
    }
  };
  const recordDrawerOpen = () => {
    const state = mobileHistoryState(true, true);
    if (historyPolicy === "stack") window.history.pushState(state, "");
    else window.history.replaceState(state, "");
  };
  const closeDrawer = () => {
    if (
      historyPolicy === "stack" &&
      window.history.state?.webloungeMobileDrawer === true
    ) {
      drawerCloseAwaitingHistory = true;
      window.history.back();
    } else {
      window.history.replaceState(mobileHistoryState(true, false), "");
      finishDrawerClose();
    }
  };
  const requestBack = (instant = false) => {
    if (drawerBufferId() !== undefined) {
      setDrawerHistoryClosing(true);
      return;
    }
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
    recordDrawerOpen();
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

  createEffect(() => {
    const stable =
      stack().active.kind === "chats" && stack().transition === undefined;
    if (stable && !chatsStable) {
      setScrollRestoreVersion((version) => version + 1);
    }
    chatsStable = stable;
  });

  const beginPan = (event: PointerEvent) => {
    suppressCompletedSwipeClick = false;
    const target = event.target as Element;
    const width =
      event.currentTarget instanceof Element
        ? event.currentTarget.getBoundingClientRect().width
        : window.innerWidth;
    if (
      event.clientX <= 24 &&
      stack().active.kind === "chat" &&
      stack().transition === undefined &&
      target.closest(
        "[data-selectable], input, textarea, [data-horizontal-scroll]",
      ) === null
    ) {
      swipeGesture.begin(event, width);
      return;
    }
    const active = stack().active;
    const buffer =
      active.kind === "chat"
        ? props.buffers.find((candidate) => candidate.id === active.bufferId)
        : undefined;
    const selection = window.getSelection();
    if (
      event.clientX <= 24 ||
      event.clientX >= width - 24 ||
      buffer?.kind !== "channel" ||
      drawerBufferId() !== undefined ||
      stack().transition !== undefined ||
      (selection !== null && !selection.isCollapsed) ||
      target.closest(
        "[data-selectable], input, textarea, [data-horizontal-scroll]",
      ) !== null
    )
      return;
    memberOpenBufferId = buffer.id;
    memberOpenGesture.begin(event, width);
  };
  const returnSwipe = () => {
    if (platform.prefersReducedMotion() || swipeProgress() === 0) {
      setSwipeProgress(undefined);
      return;
    }
    setSwipeReturning(true);
    setSwipeProgress(0);
  };
  const swipeGesture = createHorizontalPan({
    commitRatio: 0.5,
    commitVelocity: 0.5,
    direction: "right",
    preventDefaultOnStart: true,
    onCancel: returnSwipe,
    onCommit: () => {
      suppressCompletedSwipeClick = true;
      setSwipeProgress(undefined);
      requestBack(true);
    },
    onProgress: setSwipeProgress,
  });
  const cancelMemberOpen = () => {
    memberOpenBufferId = undefined;
    const progress = memberOpenProgress();
    if (progress === undefined) return;
    if (platform.prefersReducedMotion() || progress === 1) {
      resetMemberOpen();
      setDrawerBufferId(undefined);
      return;
    }
    memberOpenTarget = "closed";
    setMemberOpenReturning(true);
    setMemberOpenProgress(1);
  };
  const memberOpenGesture = createHorizontalPan({
    commitRatio: 0.4,
    commitVelocity: 0.5,
    direction: "left",
    onCancel: cancelMemberOpen,
    onCommit: () => {
      suppressCompletedSwipeClick = true;
      memberOpenBufferId = undefined;
      memberOpenTarget = "open";
      recordDrawerOpen();
      if (platform.prefersReducedMotion()) {
        resetMemberOpen();
        return;
      }
      setMemberOpenReturning(true);
      setMemberOpenProgress(0);
    },
    onProgress: (progress) => {
      if (progress === 0 && memberOpenProgress() === undefined) return;
      setMemberOpenReturning(false);
      setMemberOpenProgress(1 - progress);
      if (drawerBufferId() === undefined) {
        setMemberFilter("");
        setDrawerBufferId(memberOpenBufferId);
      }
    },
  });
  const finishMemberOpenReturn = () => {
    const target = memberOpenTarget;
    resetMemberOpen();
    if (target === "closed") setDrawerBufferId(undefined);
  };
  const consumeCompletedSwipeClick = (event: MouseEvent) => {
    if (!suppressCompletedSwipeClick) return;
    suppressCompletedSwipeClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
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
        if (drawerBufferId() !== undefined) finishDrawerClose();
        replaceWithRoot();
        return;
      }
      const browserHandledSwipe =
        pendingHistoryPopInstant ||
        swipeGesture.active() ||
        swipeProgress() !== undefined;
      pendingHistoryPopInstant = false;
      resetSwipe();
      if (drawerBufferId() === undefined)
        dispatchBack(browserHandledSwipe || reducedMotion());
      else if (drawerCloseAwaitingHistory) finishDrawerClose();
      else if (reducedMotion()) finishDrawerClose();
      else setDrawerHistoryClosing(true);
    };
    const handleVisibilityChange = () => resetMotion();
    window.addEventListener("popstate", handlePopState);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    shellElement?.addEventListener("click", consumeCompletedSwipeClick, true);
    if (historyPolicy === "replace") {
      window.history.replaceState(
        mobileHistoryState(stack().active.kind === "chat", false),
        "",
      );
    }
    onCleanup(() => {
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      shellElement?.removeEventListener(
        "click",
        consumeCompletedSwipeClick,
        true,
      );
    });
  });

  return (
    <main
      class={styles.shell}
      data-history-policy={historyPolicy}
      data-mobile-shell="true"
      onPointerCancel={(event) => {
        swipeGesture.cancel(event);
        memberOpenGesture.cancel(event);
      }}
      onPointerDown={beginPan}
      onPointerMove={(event) => {
        swipeGesture.move(event);
        memberOpenGesture.move(event);
      }}
      onPointerUp={(event) => {
        swipeGesture.end(event);
        memberOpenGesture.end(event);
      }}
      ref={shellElement}
    >
      <For each={screens()}>
        {(screen, index) => {
          const transition = () => stack().transition;
          return (
            <MobileScreen
              buffers={props.buffers}
              chatsScrollTop={() => returnScrollTop}
              chatsScrollVersion={scrollRestoreVersion}
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
              onOpen={(bufferId, currentScrollTop) =>
                open(bufferId, false, currentScrollTop)
              }
              onOpenMembers={openMembers}
              onQuery={setQuery}
              onRequestCompletion={props.onRequestCompletion}
              onRetryNetwork={props.onRetryNetwork}
              onRetry={props.onRetry}
              onScroll={(nextScrollTop) => {
                if (
                  stack().active.kind === "chats" &&
                  stack().transition === undefined
                )
                  returnScrollTop = nextScrollTop;
              }}
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
          closing={drawerHistoryClosing() || undefined}
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
          }}
          onOpenReturnEnd={finishMemberOpenReturn}
          onRequestRange={(offset) =>
            props.onRequestMembers?.(
              memberViewId,
              drawerBufferId() ?? 0,
              offset,
              memberFilter(),
            )
          }
          openProgress={memberOpenProgress()}
          openReturning={memberOpenReturning() || undefined}
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
