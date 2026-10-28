import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
} from "solid-js";
import type { MemberWindow } from "../../features/members/MemberPanel";
import { MobileMemberDrawer } from "./MobileMemberDrawer";
import { MobileScreen, type MobileShellData } from "./MobileScreen";
import styles from "./MobileShell.module.css";
import type { ChatFilter } from "./mobile-chats";
import {
  createMobileStack,
  finishTransition,
  mountedScreens,
  popChat,
  previousScreen,
  pushChat,
  swipeBackCompletes,
} from "./mobile-navigation";
import { type MobileViewport, observeMobileViewport } from "./mobile-viewport";

interface MobileShellProps extends MobileShellData {
  readonly focusRequest?: { readonly bufferId: number } | undefined;
  readonly initialBufferId?: number | undefined;
  readonly onSelectBuffer: (bufferId: number) => void;
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
  let pushNextFocus = false;
  let gesture:
    | { pointerId: number; startX: number; startedAt: number; width: number }
    | undefined;

  const open = (bufferId: number, preserveCurrent = false) => {
    props.onSelectBuffer(bufferId);
    const state = { ...historyState(), webloungeMobileChat: true };
    if (stack().active.kind === "chats" || preserveCurrent)
      window.history.pushState(state, "");
    else window.history.replaceState(state, "");
    setStack((current) =>
      pushChat(current, bufferId, reducedMotion(), preserveCurrent),
    );
  };
  const dispatchBack = () =>
    setStack((current) => popChat(current, reducedMotion()));
  const finishDrawerClose = () => {
    setDrawerBufferId(undefined);
    if (pendingDirect !== undefined) {
      pushNextFocus = true;
      props.onOpenDirect?.(pendingDirect.networkId, pendingDirect.nick);
      pendingDirect = undefined;
    }
  };
  const closeDrawer = () => {
    if (window.history.state?.webloungeMobileDrawer === true)
      window.history.back();
    else finishDrawerClose();
  };
  const requestBack = () => {
    if (drawerBufferId() !== undefined) return closeDrawer();
    if (window.history.state?.webloungeMobileChat === true) {
      window.history.back();
    } else {
      dispatchBack();
    }
  };
  const openMembers = (bufferId: number) => {
    setMemberFilter("");
    setDrawerBufferId(bufferId);
    window.history.pushState(
      { ...historyState(), webloungeMobileDrawer: true },
      "",
    );
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
      requestBack();
    } else returnSwipe();
  };
  const cancelSwipe = (event: PointerEvent) => {
    if (gesture?.pointerId !== event.pointerId) return;
    gesture = undefined;
    returnSwipe();
  };
  const screens = () =>
    swipeProgress() === undefined
      ? mountedScreens(stack())
      : [previousScreen(stack()), stack().active];

  onMount(() => {
    const handlePopState = () =>
      drawerBufferId() === undefined ? dispatchBack() : finishDrawerClose();
    window.addEventListener("popstate", handlePopState);
    const stopViewport = observeMobileViewport(window, setViewport);
    onCleanup(() => {
      stopViewport();
      window.removeEventListener("popstate", handlePopState);
    });
  });

  return (
    <main
      class={styles.shell}
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
              swipeReturning={swipeReturning() || undefined}
              swipeProgress={swipeProgress()}
              transition={transition()?.direction}
              onSwipeReturnEnd={() => {
                setSwipeReturning(false);
                setSwipeProgress(undefined);
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

function historyState(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null
    ? (state as Record<string, unknown>)
    : {};
}
