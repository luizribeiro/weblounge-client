import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
} from "solid-js";
import type { MemberWindow } from "../../features/members/MemberPanel";
import { platformEnvironment } from "../../platform/environment";
import { recordGestureNotStarted } from "../../platform/gesture-debug";
import { mobileHistoryPolicy } from "../../platform/mobile-history";
import { createHorizontalPan, type PanRelease } from "../../ui/horizontal-pan";
import { afterStartStatePaints } from "../../ui/transform-motion";
import { MobileMemberDrawer } from "./MobileMemberDrawer";
import { MobileScreen, type MobileShellData } from "./MobileScreen";
import styles from "./MobileShell.module.css";
import type { ChatFilter } from "./mobile-chats";
import {
  createMobileStack,
  finishTransition,
  layeredScreens,
  type MobileScreen as MobileScreenState,
  type MobileTransition,
  popChat,
  previousScreen,
  pushChat,
} from "./mobile-navigation";
import {
  type PushMotion,
  type ReleasedSwipe,
  releasedSwipe,
  type SwipeMotion,
  stackMotion,
} from "./push-motion";

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

// Replace with a pixel width to restrict Back to a leading-edge strip.
export const swipeBackActivationWidth = Number.POSITIVE_INFINITY;

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
  const [swipe, setSwipe] = createSignal<SwipeMotion>();
  const [paintedPush, setPaintedPush] = createSignal<MobileTransition>();
  const [drawerBufferId, setDrawerBufferId] = createSignal<number>();
  const [memberFilter, setMemberFilter] = createSignal("");
  const [memberOpenProgress, setMemberOpenProgress] = createSignal<number>();
  const [memberOpenReturning, setMemberOpenReturning] = createSignal(false);
  const [drawerHistoryClosing, setDrawerHistoryClosing] = createSignal(false);
  const drawerBuffer = createMemo(() =>
    props.buffers.find((buffer) => buffer.id === drawerBufferId()),
  );
  let handledFocusRequest: { readonly bufferId: number } | undefined;
  let acceptedInitialBuffer = initialBufferId !== undefined;
  let memberOpenBufferId: number | undefined;
  let memberOpenTarget: "closed" | "open" | undefined;
  let pendingDirect: { networkId: number; nick: string } | undefined;
  let drawerCloseAwaitingHistory = false;
  let completedBeforePop = false;
  let pushNextFocus = false;
  let suppressCompletedSwipeClick = false;
  let shellElement: HTMLElement | undefined;
  let chatsStable = true;
  let returnScrollTop = 0;
  const requestedHistory = new Set<number>();
  const requestHistoryOnce = (bufferId: number) => {
    if (requestedHistory.has(bufferId)) return;
    requestedHistory.add(bufferId);
    props.onLoadHistory(bufferId);
  };

  createEffect(() => {
    const nextInitialBufferId = props.initialBufferId;
    if (
      acceptedInitialBuffer ||
      nextInitialBufferId === undefined ||
      window.location.pathname === "/"
    ) {
      return;
    }
    acceptedInitialBuffer = true;
    setStack((current) => pushChat(current, nextInitialBufferId, true));
  });

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
  const completingSwipe = () => swipe()?.phase === "completing";
  const resetSwipe = (reason?: "visibility" | "popstate") => {
    completedBeforePop = false;
    swipeGesture.reset(reason);
    setSwipe(undefined);
  };
  const resetMemberOpen = (reason?: "visibility" | "popstate") => {
    memberOpenGesture.reset(reason);
    memberOpenBufferId = undefined;
    memberOpenTarget = undefined;
    setMemberOpenReturning(false);
    setMemberOpenProgress(undefined);
  };
  const resetMotion = (reason: "visibility" | "popstate") => {
    resetSwipe(reason);
    if (memberOpenTarget === "open") resetMemberOpen(reason);
    else if (memberOpenProgress() !== undefined) {
      resetMemberOpen(reason);
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
  const requestBack = () => {
    if (drawerBufferId() !== undefined) {
      setDrawerHistoryClosing(true);
      return;
    }
    if (
      historyPolicy === "stack" &&
      window.history.state?.webloungeMobileChat === true
    ) {
      window.history.back();
    } else {
      dispatchBack(reducedMotion() && !completingSwipe());
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

  const pushTransition = createMemo(() => {
    const transition = stack().transition;
    return transition?.direction === "push" ? transition : undefined;
  });
  createEffect(() => {
    const transition = pushTransition();
    if (transition === undefined) return;
    onCleanup(afterStartStatePaints(() => setPaintedPush(transition)));
  });

  const beginPan = (event: PointerEvent) => {
    suppressCompletedSwipeClick = false;
    if (event.isPrimary === false) {
      recordGestureNotStarted("swipe-back", event, "non-primary");
      return;
    }
    const target = event.target as Element;
    const width =
      event.currentTarget instanceof Element
        ? event.currentTarget.getBoundingClientRect().width
        : window.innerWidth;
    const active = stack().active;
    const buffer =
      active.kind === "chat"
        ? props.buffers.find((candidate) => candidate.id === active.bufferId)
        : undefined;
    const selection = window.getSelection();
    const excluded =
      (selection !== null && !selection.isCollapsed) ||
      target.closest(
        "[data-selectable], input, textarea, [data-horizontal-scroll]",
      ) !== null;
    const currentSwipe = swipe();
    const canStartSwipe =
      event.clientX <= swipeBackActivationWidth &&
      active.kind === "chat" &&
      stack().transition === undefined &&
      (currentSwipe === undefined || currentSwipe.phase === "returning") &&
      drawerBufferId() === undefined &&
      !excluded;
    if (canStartSwipe) {
      const initialProgress =
        currentSwipe?.phase === "returning"
          ? renderedSwipeProgress(shellElement, width)
          : 0;
      if (currentSwipe?.phase === "returning")
        setSwipe({ phase: "dragging", progress: initialProgress });
      swipeGesture.begin(event, width, initialProgress);
    } else {
      recordGestureNotStarted(
        "swipe-back",
        event,
        swipeNotStartedReason(
          active.kind,
          stack().transition,
          currentSwipe,
          drawerBufferId(),
          excluded,
        ),
      );
    }
    if (
      event.clientX <= 24 ||
      event.clientX >= width - 24 ||
      buffer?.kind !== "channel" ||
      drawerBufferId() !== undefined ||
      stack().transition !== undefined ||
      excluded
    )
      return;
    memberOpenBufferId = buffer.id;
    memberOpenGesture.begin(event, width);
  };
  const releaseSwipe = (phase: ReleasedSwipe["phase"], release: PanRelease) => {
    const current = swipe();
    const progress = current?.phase === "dragging" ? current.progress : 0;
    setSwipe(releasedSwipe(phase, progress, release.progressPerMs));
  };
  const returnSwipe = (release: PanRelease) => {
    const current = swipe();
    if (current?.phase === "dragging" && current.progress > 0)
      releaseSwipe("returning", release);
    else resetSwipe();
  };
  const swipeGesture = createHorizontalPan({
    commitRatio: 0.5,
    commitVelocity: 0.25,
    debugRegion: "swipe-back",
    direction: "right",
    onCancel: returnSwipe,
    onCommit: (release) => {
      suppressCompletedSwipeClick = true;
      releaseSwipe("completing", release);
      requestBack();
    },
    onProgress: (progress) => setSwipe({ phase: "dragging", progress }),
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
    commitVelocity: 0.25,
    debugRegion: "member-open",
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
    retainChatsScreen(stack(), layeredScreens(stack(), swipe() !== undefined));
  const movingScreen = () => {
    const current = stack();
    const transition = current.transition;
    if (transition !== undefined)
      return transition.direction === "push" ? transition.to : transition.from;
    return swipe() === undefined ? undefined : current.active;
  };
  const motion = (): PushMotion | undefined => {
    const transition = stack().transition;
    const current = swipe();
    if (transition === undefined) return current;
    if (transition.direction === "pop" && current?.phase === "completing")
      return current;
    return stackMotion(transition, paintedPush() === transition);
  };
  const settleMotion = () => {
    const current = motion();
    if (current?.phase === "opening" || current?.phase === "closing")
      setStack(finishTransition);
    else if (current?.phase === "returning") resetSwipe();
    else if (current?.phase === "completing") settleCompletedSwipe();
  };
  const settleCompletedSwipe = () => {
    if (stack().transition?.direction !== "pop") {
      completedBeforePop = true;
      return;
    }
    batch(() => {
      setStack(finishTransition);
      resetSwipe();
    });
  };
  const popCompletedSwipe = () => {
    if (!completedBeforePop) {
      dispatchBack(false);
      return;
    }
    batch(() => {
      dispatchBack(true);
      resetSwipe();
    });
  };
  const screenIsRetained = (screen: MobileScreenState) => {
    const current = stack();
    if (screen.kind !== "chats" || current.active.kind === "chats")
      return false;
    if (swipe() !== undefined) return previousScreen(current) !== screen;
    return (
      current.transition?.from !== screen && current.transition?.to !== screen
    );
  };

  onMount(() => {
    const handlePopState = () => {
      if (historyPolicy === "replace") {
        resetMotion("popstate");
        if (drawerBufferId() !== undefined) finishDrawerClose();
        replaceWithRoot();
        return;
      }
      if (completingSwipe()) {
        popCompletedSwipe();
        return;
      }
      const browserHandledSwipe =
        swipeGesture.active() || swipe() !== undefined;
      resetSwipe("popstate");
      if (drawerBufferId() === undefined)
        dispatchBack(browserHandledSwipe || reducedMotion());
      else if (drawerCloseAwaitingHistory) finishDrawerClose();
      else if (reducedMotion()) finishDrawerClose();
      else setDrawerHistoryClosing(true);
    };
    const handleVisibilityChange = () => resetMotion("visibility");
    const handleKeydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        drawerBufferId() !== undefined ||
        stack().active.kind !== "chat" ||
        stack().transition !== undefined ||
        swipe() !== undefined ||
        !isKeyboardBack(event, platform.shortcutPlatform)
      )
        return;
      event.preventDefault();
      requestBack();
    };
    window.addEventListener("popstate", handlePopState);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("keydown", handleKeydown);
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
      document.removeEventListener("keydown", handleKeydown);
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
      onLostPointerCapture={(event) => {
        swipeGesture.lostCapture(event);
        memberOpenGesture.lostCapture(event);
      }}
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
        {(screen) => (
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
            onLoadHistory={requestHistoryOnce}
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
            motion={screen === movingScreen() ? motion() : undefined}
            onMotionEnd={settleMotion}
            query={query()}
            retained={screenIsRetained(screen)}
            screen={screen}
          />
        )}
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

function renderedSwipeProgress(
  shell: HTMLElement | undefined,
  width: number,
): number {
  const screen = shell?.querySelector<HTMLElement>('[data-motion="returning"]');
  if (screen === undefined || screen === null || width <= 0) return 0;
  const shellLeft = shell?.getBoundingClientRect().left ?? 0;
  return Math.max(
    0,
    Math.min(1, (screen.getBoundingClientRect().left - shellLeft) / width),
  );
}

function swipeNotStartedReason(
  activeKind: MobileScreenState["kind"],
  transition: MobileTransition | undefined,
  swipe: SwipeMotion | undefined,
  drawerBufferId: number | undefined,
  excluded: boolean,
): string {
  if (activeKind !== "chat") return "not-chat";
  if (transition !== undefined) return "transition";
  if (swipe !== undefined && swipe.phase !== "returning") return "swipe-active";
  if (drawerBufferId !== undefined) return "drawer-open";
  if (excluded) return "excluded-target";
  return "outside-activation";
}

function isKeyboardBack(
  event: KeyboardEvent,
  platform: "macos" | "other",
): boolean {
  return (
    event.key === "Escape" ||
    event.key === "BrowserBack" ||
    (platform === "macos"
      ? event.metaKey && event.key === "["
      : event.altKey && event.key === "ArrowLeft")
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
