import {
  createVirtualizer,
  measureElement,
  observeElementRect,
} from "@tanstack/solid-virtual";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import type {
  MembershipProjection,
  MessageProjection,
  NoticeKind,
  TypingProjection,
} from "../../engine/protocol";
import { pageIsForeground } from "../../platform/push/foreground-state";
import {
  type AppGeometryChange,
  appGeometryChangeEvent,
} from "../../platform/viewport-geometry";
import { t } from "../../strings";
import type { CopyRow } from "../../ui/copy-rows";
import { copySelectedRows } from "../../ui/copy-selection";
import { formatTime, formattedTimeColumnWidth } from "../../ui/format-time";
import { Line } from "../../ui/Line";
import { Selectable } from "../../ui/Selectable";
import { ScrollIntentTracker } from "../../ui/scroll-intent";
import { observeVirtualizerOffset } from "../../ui/virtualizer-observer";
import { preserveVisualScrollAnchor } from "../../ui/visual-scroll-anchor";
import {
  composerGeometryChangeEvent,
  composerGeometryWillChangeEvent,
} from "../composer/geometry";
import { TypingIndicator } from "../composer/TypingIndicator";
import styles from "./MessageList.module.css";
import { MessageText, Nickname } from "./MessageText";
import {
  currentMessageDensity,
  estimateMessageHeight,
} from "./message-size-estimate";
import { createNickLookup, type NickDisplay } from "./nick-lookup";

interface MessageListProps {
  readonly bufferId?: number | undefined;
  readonly presentation?: "desktop" | "mobile" | undefined;
  readonly messages: readonly MessageProjection[];
  readonly memberships?: readonly MembershipProjection[] | undefined;
  readonly typers?: readonly TypingProjection[] | undefined;
  readonly readAtMs?: number | null | undefined;
  readonly onLiveEdgeChange?: (atLiveEdge: boolean) => void;
  readonly onOpenChannel?: ((channel: string) => void) | undefined;
  readonly onOpenDirect?: ((nick: string) => void) | undefined;
  readonly onOpenExternal?: ((href: string) => void) | undefined;
  readonly onRejoin?: (() => void) | undefined;
  readonly onRetry?: ((localSendId: number) => void) | undefined;
  readonly registerController?:
    | ((controller: MessageListController) => void)
    | undefined;
}

export interface MessageListController {
  readonly jumpBottom: () => void;
  readonly selectLastOwn: () => void;
}

type TimelineRow =
  | { readonly kind: "day"; readonly key: string; readonly label: string }
  | { readonly kind: "new"; readonly key: string }
  | {
      readonly kind: "membership";
      readonly key: string;
      readonly membership: MembershipProjection;
    }
  | {
      readonly kind: "message";
      readonly key: string;
      readonly message: MessageProjection;
    };

type NoticeMessage = MessageProjection & {
  readonly kind: { readonly notice: NoticeKind };
};

const liveEdgeTolerance = 2;

export function MessageList(props: MessageListProps) {
  let list: HTMLDivElement | undefined;
  let liveEdgeSentinel: HTMLElement | undefined;
  let observedWidth: number | undefined;
  let observedHeight: number | undefined;
  let syncViewportRect: (() => boolean) | undefined;
  const estimatedDensity = currentMessageDensity(document.documentElement);
  const estimatedSizes = new Map<string, number>();
  let renderedCount = 0;
  let currentBuffer = props.bufferId;
  const initialReadAt = props.readAtMs ?? null;
  let boundaryFrozen = hasUnreadAfter(props.messages, initialReadAt);
  let logicallyAtLiveEdge = true;
  let scrollLiveEdgeFrame: number | undefined;
  let scrollFrozenReadAt: number | undefined;
  const [frozenReadAt, setFrozenReadAt] = createSignal(initialReadAt);
  const [publishedAtLiveEdge, setPublishedAtLiveEdge] = createSignal(true);
  const [unseen, setUnseen] = createSignal(0);
  const [selectedMessage, setSelectedMessage] = createSignal<number>();
  const [viewportHeight, setViewportHeight] = createSignal(768);
  const [typingSlotHeight, setTypingSlotHeight] = createSignal(0);
  const rows = createMemo(() =>
    timelineRows(props.messages, props.memberships ?? [], frozenReadAt()),
  );
  // TanStack rebuilds its index-keyed measurements only when the row count or
  // the key extractor's identity changes, and a moving divider keeps the count.
  const rowKey = createMemo(() => {
    const current = rows();
    return (index: number) => current[index]?.key ?? index;
  });
  const nickLookup = createMemo(() => createNickLookup(props.messages));
  const freezeUnreadBoundary = (write: (readAtMs: number) => void) => {
    if (boundaryFrozen) return;
    const lastSeen = latestMessageTime(props.messages);
    if (lastSeen === undefined) return;
    boundaryFrozen = true;
    if (!hasUnreadAfter(props.messages, frozenReadAt())) write(lastSeen);
  };
  const setLiveEdge = (live: boolean) => {
    if (scrollLiveEdgeFrame !== undefined) {
      window.cancelAnimationFrame(scrollLiveEdgeFrame);
      scrollLiveEdgeFrame = undefined;
      scrollFrozenReadAt = undefined;
    }
    if (!live && logicallyAtLiveEdge) freezeUnreadBoundary(setFrozenReadAt);
    logicallyAtLiveEdge = live;
    setPublishedAtLiveEdge(live);
    if (live) setUnseen(0);
    props.onLiveEdgeChange?.(live);
  };
  const deferScrollLiveEdge = (live: boolean) => {
    if (!live && logicallyAtLiveEdge)
      freezeUnreadBoundary((readAtMs) => {
        scrollFrozenReadAt = readAtMs;
      });
    // Arrivals must observe the user's position immediately, while reactive
    // publication waits because it can rewrite virtual transcript geometry.
    logicallyAtLiveEdge = live;
    if (scrollLiveEdgeFrame !== undefined) return;
    scrollLiveEdgeFrame = window.requestAnimationFrame(() => {
      scrollLiveEdgeFrame = undefined;
      if (scrollFrozenReadAt !== undefined) {
        setFrozenReadAt(scrollFrozenReadAt);
        scrollFrozenReadAt = undefined;
      }
      setPublishedAtLiveEdge(logicallyAtLiveEdge);
      if (logicallyAtLiveEdge) setUnseen(0);
      props.onLiveEdgeChange?.(logicallyAtLiveEdge);
    });
  };
  const userScrollIntent = new ScrollIntentTracker(() => list?.scrollTop ?? 0, {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (handle) => window.cancelAnimationFrame(handle),
  });
  const markPointerScrollIntent = (event: PointerEvent) => {
    if (event.isPrimary && event.button === 0) userScrollIntent.beginPointer();
  };
  const endPointerScrollIntent = () => userScrollIntent.endPointer();
  const cancelPointerScrollIntent = (event: PointerEvent) => {
    if (event.pointerType === "touch") userScrollIntent.cancelPointer();
    else userScrollIntent.endPointer();
  };
  const markTouchScrollIntent = () => userScrollIntent.beginTouch();
  const endTouchScrollIntent = (event: TouchEvent) => {
    if (event.touches.length === 0) userScrollIntent.endTouch();
  };
  const markWheelScrollIntent = () => userScrollIntent.beginDiscrete();
  const markScrollKeyIntent = (event: KeyboardEvent) => {
    if (scrollKeys.has(event.key)) userScrollIntent.beginDiscrete();
  };
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLLIElement>({
    get count() {
      return rows().length;
    },
    getScrollElement: () => list ?? null,
    observeElementOffset: observeVirtualizerOffset,
    initialRect: { width: 1024, height: 768 },
    observeElementRect: (instance, callback) => {
      const updateRect = (rect: {
        readonly height: number;
        readonly width: number;
      }) => {
        const next = rect.height === 0 ? { width: 1024, height: 768 } : rect;
        const widthChanged =
          observedWidth !== undefined && observedWidth !== next.width;
        const viewportChanged =
          widthChanged ||
          (observedHeight !== undefined && observedHeight !== next.height);
        const followEnd = viewportChanged && logicallyAtLiveEdge;
        if (observedWidth !== next.width) estimatedSizes.clear();
        observedWidth = next.width;
        observedHeight = next.height;
        setViewportHeight(next.height);
        callback(next);
        if (widthChanged) remeasure();
        if (followEnd) virtualizer.scrollToEnd();
        return followEnd;
      };
      const updateCurrentRect = () => {
        const element = instance.scrollElement;
        if (element === null) return false;
        return updateRect({
          height: element.clientHeight,
          width: element.clientWidth,
        });
      };
      syncViewportRect = updateCurrentRect;
      const stop = observeElementRect(instance, updateRect);
      return () => {
        if (syncViewportRect === updateCurrentRect)
          syncViewportRect = undefined;
        stop?.();
      };
    },
    estimateSize: (index) => {
      const row = rows()[index];
      if (row?.kind !== "message") return 34;
      const width =
        observedWidth ?? (props.presentation === "mobile" ? 402 : 1024);
      const cached = estimatedSizes.get(row.key);
      if (cached !== undefined) return cached;
      const estimated = estimateMessageHeight(
        row.message,
        width,
        estimatedDensity,
      );
      estimatedSizes.set(row.key, estimated);
      return estimated;
    },
    get getItemKey() {
      return rowKey();
    },
    measureElement: (element, entry, instance) => {
      const index = Number(element.dataset.index);
      const measured = measureRowElement(element, entry, instance);
      const size =
        measured > 0 ? measured : instance.options.estimateSize(index);
      return size;
    },
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: liveEdgeTolerance,
    // The sentinel can report before the virtualizer has seen a scroll that
    // reached the end. Arrival can therefore come from either source, while
    // only user input can leave the edge; layout gaps must not freeze it.
    onChange: (instance) => {
      if (!logicallyAtLiveEdge && instance.isAtEnd()) setLiveEdge(true);
    },
    overscan: props.presentation === "mobile" ? 24 : 6,
  });
  const remeasure = () => {
    if (list?.isConnected !== true) return;
    preserveVisualScrollAnchor(list, () => {
      virtualizer.measure();
      for (const element of list?.querySelectorAll<HTMLLIElement>(
        "li[data-index]",
      ) ?? [])
        virtualizer.measureElement(element);
    });
  };
  const measureRow = (element: HTMLLIElement, index: number) => {
    element.dataset.index = String(index);
    const measured = measureElement(element, undefined, virtualizer);
    if (measured > 0) virtualizer.resizeItem(index, measured);
    virtualizer.measureElement(element);
  };
  const reportLiveEdge = (sentinelVisible: boolean) => {
    if (sentinelVisible && virtualizer.isAtEnd()) {
      setLiveEdge(true);
    }
  };
  const jumpToBottom = () => {
    if (list === undefined || rows().length === 0) return;
    setLiveEdge(true);
    virtualizer.scrollToEnd();
  };
  const selectLastOwn = () => {
    const message = [...props.messages]
      .reverse()
      .find((item) => item.authorship === "own" && !isNoticeMessage(item));
    if (message === undefined) return;
    const index = rows().findIndex(
      (row) => row.kind === "message" && row.message.id === message.id,
    );
    if (index < 0) return;
    setSelectedMessage(message.id);
    virtualizer.scrollToIndex(index, { align: "auto" });
    queueMicrotask(() => list?.focus());
  };
  props.registerController?.({ jumpBottom: jumpToBottom, selectLastOwn });

  createEffect(() => {
    if (props.bufferId !== currentBuffer) {
      currentBuffer = props.bufferId;
      setFrozenReadAt(props.readAtMs ?? null);
      boundaryFrozen = false;
      renderedCount = 0;
      setUnseen(0);
      setLiveEdge(true);
      virtualizer.scrollToEnd();
    }
  });
  createEffect(() => {
    const marker = props.readAtMs ?? null;
    const hasUnread = hasUnreadAfter(props.messages, marker);
    const away =
      !publishedAtLiveEdge() || !pageIsForeground(document, navigator);
    if (hasUnread && away) {
      boundaryFrozen = true;
      setFrozenReadAt(marker);
    } else if (!boundaryFrozen) {
      setFrozenReadAt(
        hasUnread ? (latestMessageTime(props.messages) ?? marker) : marker,
      );
    }
  });
  createEffect(() => {
    const messages = props.messages;
    const previousCount = renderedCount;
    if (messages.length > previousCount && !logicallyAtLiveEdge)
      setUnseen((count) => count + messages.length - previousCount);
    renderedCount = messages.length;
    if (messages.length !== previousCount && logicallyAtLiveEdge)
      virtualizer.scrollToEnd();
  });
  onMount(() => {
    if (list !== undefined) {
      const value = Number.parseFloat(
        getComputedStyle(list).getPropertyValue("--wl-typing-slot-height"),
      );
      if (!Number.isFinite(value))
        throw new Error("typing slot height is not defined in CSS");
      setTypingSlotHeight(value);
    }
    const fonts = document.fonts;
    const composerOwner = list?.parentElement?.parentElement;
    const anchorComposerGeometry = () => {
      syncViewportRect?.();
    };
    const cancelComposerScroll = () => {
      if (logicallyAtLiveEdge) virtualizer.cancelScroll();
    };
    const handleFontsLoaded = () => {
      remeasure();
      if (logicallyAtLiveEdge) virtualizer.scrollToEnd();
    };
    const updateForeground = () => {
      if (!pageIsForeground(document, navigator))
        freezeUnreadBoundary(setFrozenReadAt);
    };
    const liveEdgeObserver =
      list === undefined || typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            (entries) => {
              const entry = entries.find(
                (candidate) => candidate.target === liveEdgeSentinel,
              );
              if (entry !== undefined) reportLiveEdge(entry.isIntersecting);
            },
            { root: list },
          );
    const anchorGeometryChange = (event: Event) => {
      const { owner } = (event as CustomEvent<AppGeometryChange>).detail;
      if (list !== undefined && owner.contains(list) && logicallyAtLiveEdge) {
        const followedResizedViewport = syncViewportRect?.() ?? false;
        if (!followedResizedViewport) virtualizer.scrollToEnd();
      }
    };
    if (liveEdgeSentinel !== undefined)
      liveEdgeObserver?.observe(liveEdgeSentinel);
    void (fonts?.ready ?? Promise.resolve()).then(handleFontsLoaded);
    composerOwner?.addEventListener(
      composerGeometryChangeEvent,
      anchorComposerGeometry,
    );
    composerOwner?.addEventListener(
      composerGeometryWillChangeEvent,
      cancelComposerScroll,
    );
    fonts?.addEventListener("loadingdone", handleFontsLoaded);
    document.addEventListener("visibilitychange", updateForeground);
    window.addEventListener("focus", updateForeground);
    window.addEventListener("blur", updateForeground);
    window.addEventListener(appGeometryChangeEvent, anchorGeometryChange);
    onCleanup(() => {
      liveEdgeObserver?.disconnect();
      composerOwner?.removeEventListener(
        composerGeometryChangeEvent,
        anchorComposerGeometry,
      );
      composerOwner?.removeEventListener(
        composerGeometryWillChangeEvent,
        cancelComposerScroll,
      );
      fonts?.removeEventListener("loadingdone", handleFontsLoaded);
      document.removeEventListener("visibilitychange", updateForeground);
      window.removeEventListener("focus", updateForeground);
      window.removeEventListener("blur", updateForeground);
      window.removeEventListener(appGeometryChangeEvent, anchorGeometryChange);
      list?.removeEventListener("keydown", markScrollKeyIntent);
      list?.removeEventListener("pointerdown", markPointerScrollIntent);
      list?.removeEventListener("touchstart", markTouchScrollIntent);
      list?.removeEventListener("wheel", markWheelScrollIntent);
      window.removeEventListener("pointerup", endPointerScrollIntent);
      window.removeEventListener("pointercancel", cancelPointerScrollIntent);
      window.removeEventListener("touchend", endTouchScrollIntent);
      window.removeEventListener("touchcancel", endTouchScrollIntent);
      if (scrollLiveEdgeFrame !== undefined)
        window.cancelAnimationFrame(scrollLiveEdgeFrame);
      userScrollIntent.dispose();
    });
    queueMicrotask(jumpToBottom);
  });

  return (
    <div class={styles.surface}>
      {/* biome-ignore lint/a11y/useSemanticElements: the scroll owner wraps the semantic row layer */}
      <div
        aria-label={t("messages.label")}
        class={styles.list}
        data-message-list="true"
        data-presentation={props.presentation ?? "desktop"}
        role="list"
        onScroll={(event) => {
          if (!userScrollIntent.consumeScroll()) return;
          const element = event.currentTarget;
          deferScrollLiveEdge(
            element.scrollHeight - element.scrollTop - element.clientHeight <=
              liveEdgeTolerance,
          );
        }}
        onScrollEnd={() => userScrollIntent.settle()}
        onKeyDown={(event) => {
          if (event.key !== "End") return;
          event.preventDefault();
          jumpToBottom();
        }}
        ref={(element) => {
          list = element;
          element.addEventListener("keydown", markScrollKeyIntent);
          element.addEventListener("pointerdown", markPointerScrollIntent, {
            passive: true,
          });
          element.addEventListener("touchstart", markTouchScrollIntent, {
            passive: true,
          });
          element.addEventListener("wheel", markWheelScrollIntent, {
            passive: true,
          });
          window.addEventListener("pointerup", endPointerScrollIntent, {
            passive: true,
          });
          window.addEventListener("pointercancel", cancelPointerScrollIntent, {
            passive: true,
          });
          window.addEventListener("touchend", endTouchScrollIntent, {
            passive: true,
          });
          window.addEventListener("touchcancel", endTouchScrollIntent, {
            passive: true,
          });
        }}
        style={{ "--wl-message-time-column": formattedTimeColumnWidth() }}
        tabindex="0"
        onCopy={(event) =>
          copySelectedRows(event, event.currentTarget, toCopyRows(rows()))
        }
      >
        <ol class={styles.geometryLayer} role="presentation">
          <li
            aria-hidden="true"
            class={styles.spacer}
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          />
          <li
            aria-hidden="true"
            class={styles.liveEdge}
            data-live-edge-sentinel="true"
            ref={(element) => {
              liveEdgeSentinel = element;
            }}
            style={{
              top: `${Math.max(virtualizer.getTotalSize() - 1, 0)}px`,
            }}
          />
        </ol>
        <div
          class={styles.motionClip}
          style={{
            height: `${Math.max(viewportHeight(), virtualizer.getTotalSize())}px`,
          }}
        >
          <ol
            class={styles.motionLayer}
            data-message-motion-layer="true"
            role="presentation"
          >
            <For each={virtualizer.getVirtualItems()}>
              {(virtualRow) => {
                const row = () => rows()[virtualRow.index];
                const selected = () => {
                  const item = row();
                  return (
                    item?.kind === "message" &&
                    item.message.id === selectedMessage()
                  );
                };
                return (
                  <li
                    class={styles.virtualRow}
                    data-copy-row-index={virtualRow.index}
                    data-index={virtualRow.index}
                    data-row-key={String(virtualRow.key)}
                    data-selected={selected()}
                    ref={(element) => measureRow(element, virtualRow.index)}
                    style={{
                      transform: `translateY(${virtualRow.start + bottomOffset(viewportHeight(), virtualizer.getTotalSize(), typingSlotHeight())}px)`,
                    }}
                  >
                    <TimelineRowView
                      index={virtualRow.index}
                      nickLookup={nickLookup()}
                      onOpenChannel={props.onOpenChannel}
                      onOpenDirect={props.onOpenDirect}
                      onOpenExternal={props.onOpenExternal}
                      onRejoin={props.onRejoin}
                      onRetry={props.onRetry}
                      row={row()}
                    />
                  </li>
                );
              }}
            </For>
          </ol>
        </div>
      </div>
      <TypingIndicator typers={props.typers ?? []} />
      {unseen() > 0 && (
        <button class={styles.jump} onClick={jumpToBottom} type="button">
          {t(unseen() === 1 ? "messages.jump.one" : "messages.jump.many", {
            count: String(unseen()),
          })}
        </button>
      )}
    </div>
  );
}

const scrollKeys = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

function TimelineRowView(props: {
  readonly index: number;
  readonly nickLookup: ReadonlyMap<string, NickDisplay>;
  readonly onOpenChannel?: ((channel: string) => void) | undefined;
  readonly onOpenDirect?: ((nick: string) => void) | undefined;
  readonly onOpenExternal?: ((href: string) => void) | undefined;
  readonly onRejoin?: (() => void) | undefined;
  readonly onRetry?: ((localSendId: number) => void) | undefined;
  readonly row: TimelineRow | undefined;
}) {
  return (
    <Show when={props.row} keyed>
      {(row) => (
        <Switch>
          <Match when={row.kind === "day"}>
            <div class={styles.divider} data-day-divider="true">
              <span>{row.kind === "day" ? row.label : ""}</span>
            </div>
          </Match>
          <Match when={row.kind === "new"}>
            <div class={styles.newLine} data-new-line="true">
              <span>{t("messages.new")}</span>
            </div>
          </Match>
          <Match when={row.kind === "message"}>
            {row.kind === "message" && (
              <MessageRow
                index={props.index}
                message={row.message}
                nickLookup={props.nickLookup}
                onOpenChannel={props.onOpenChannel}
                onOpenDirect={props.onOpenDirect}
                onOpenExternal={props.onOpenExternal}
                onRetry={props.onRetry}
              />
            )}
          </Match>
          <Match when={row.kind === "membership"}>
            {row.kind === "membership" && (
              <div class={styles.membership} data-membership-row="true">
                {row.membership.type === "kicked" ? (
                  <>
                    ← {kickText(row.membership)} ·{" "}
                    <button onClick={() => props.onRejoin?.()} type="button">
                      {t("messages.rejoin")}
                    </button>
                  </>
                ) : (
                  <>
                    {membershipArrow(row.membership.kind)}{" "}
                    {formatNicks(row.membership.nicks)}{" "}
                    {membershipVerb(row.membership.kind)}
                  </>
                )}
              </div>
            )}
          </Match>
        </Switch>
      )}
    </Show>
  );
}

function MessageRow(props: {
  readonly index: number;
  readonly message: MessageProjection;
  readonly nickLookup: ReadonlyMap<string, NickDisplay>;
  readonly onOpenChannel?: ((channel: string) => void) | undefined;
  readonly onOpenDirect?: ((nick: string) => void) | undefined;
  readonly onOpenExternal?: ((href: string) => void) | undefined;
  readonly onRetry?: ((localSendId: number) => void) | undefined;
}) {
  const message = props.message;
  if (isNoticeMessage(message))
    return (
      <NoticeRow
        message={message}
        nickLookup={props.nickLookup}
        onOpenChannel={props.onOpenChannel}
        onOpenDirect={props.onOpenDirect}
        onOpenExternal={props.onOpenExternal}
      />
    );
  return (
    <div
      class={`${styles.row} ${message.highlighted ? styles.highlighted : ""} ${message.unverified_sender === true ? styles.unverified : ""} ${message.kind === "action" ? styles.action : ""}`}
      data-delivery={message.delivery}
      data-message-row="true"
      data-message-text={message.text}
      data-unverified-sender={message.unverified_sender === true || undefined}
    >
      {message.kind === "action" ? (
        <>
          <Selectable
            class={styles.actionText}
            surfaceId={`message-${message.id}`}
          >
            <span aria-hidden="true" class={styles.actionStar}>
              *
            </span>{" "}
            <Nickname
              class={styles.actionNick}
              display={message}
              onOpenDirect={props.onOpenDirect}
              value={message.author}
            />
            <UnverifiedSenderMark message={message} />{" "}
            <MessageText
              authors={props.nickLookup}
              onOpenChannel={props.onOpenChannel}
              onOpenDirect={props.onOpenDirect}
              onOpenExternal={props.onOpenExternal}
              text={message.text}
            />
          </Selectable>
          <Delivery message={message} onRetry={props.onRetry} />
        </>
      ) : (
        <>
          <time
            class={styles.time}
            data-message-chrome="true"
            dateTime={new Date(messageTime(message)).toISOString()}
          >
            <Line>{formatTime(messageTime(message))}</Line>
          </time>
          <Line class={styles.nickColumn} data-message-chrome="true">
            <span class={styles.nickIdentity}>
              <Nickname
                class={styles.nick}
                display={message}
                onOpenDirect={props.onOpenDirect}
                title={message.author}
                value={message.author}
              />
            </span>
            {message.bot === true && (
              <span class={styles.bot}>{t("common.bot")}</span>
            )}
            <UnverifiedSenderMark message={message} />
          </Line>
          <Selectable class={styles.text} surfaceId={`message-${message.id}`}>
            <MessageText
              authors={props.nickLookup}
              onOpenChannel={props.onOpenChannel}
              onOpenDirect={props.onOpenDirect}
              onOpenExternal={props.onOpenExternal}
              text={message.text}
            />
          </Selectable>
          <Delivery message={message} onRetry={props.onRetry} />
        </>
      )}
    </div>
  );
}

function UnverifiedSenderMark(props: { readonly message: MessageProjection }) {
  return props.message.unverified_sender === true ? (
    <span
      aria-label={t("messages.unverified_sender")}
      class={styles.unverifiedMark}
      role="img"
      title={t("messages.unverified_sender")}
    >
      ?
    </span>
  ) : null;
}

function NoticeRow(props: {
  readonly message: NoticeMessage;
  readonly nickLookup: ReadonlyMap<string, NickDisplay>;
  readonly onOpenChannel?: ((channel: string) => void) | undefined;
  readonly onOpenDirect?: ((nick: string) => void) | undefined;
  readonly onOpenExternal?: ((href: string) => void) | undefined;
}) {
  const message = props.message;
  const notice = message.kind.notice;
  switch (notice.type) {
    case "info":
      return (
        <div
          class={styles.notice}
          data-message-row="true"
          data-message-text={message.text}
          data-notice-kind="info"
          data-notice-row="true"
        >
          <Selectable
            class={styles.noticeText}
            surfaceId={`message-${message.id}`}
          >
            <MessageText
              authors={props.nickLookup}
              onOpenChannel={props.onOpenChannel}
              onOpenDirect={props.onOpenDirect}
              onOpenExternal={props.onOpenExternal}
              text={message.text}
            />
          </Selectable>
        </div>
      );
    case "topic":
      return (
        <div
          class={styles.notice}
          data-message-row="true"
          data-message-text={message.text}
          data-notice-kind="topic"
          data-notice-row="true"
        >
          <span>{t("messages.topic_prefix")}</span>
          <Selectable
            class={styles.noticeTopic}
            surfaceId={`message-${message.id}`}
          >
            {message.text === "" ? (
              t("messages.topic.empty")
            ) : (
              <MessageText
                authors={props.nickLookup}
                onOpenChannel={props.onOpenChannel}
                onOpenDirect={props.onOpenDirect}
                onOpenExternal={props.onOpenExternal}
                text={message.text}
              />
            )}
          </Selectable>
          {notice.setter !== null && notice.setter !== "" && (
            <span>{t("messages.topic.setter", { setter: notice.setter })}</span>
          )}
          {notice.set_at !== null && (
            <time dateTime={new Date(notice.set_at).toISOString()}>
              {" ·"}
              {formatNoticeTime(notice.set_at)}
            </time>
          )}
        </div>
      );
    default:
      return assertNever(notice);
  }
}

function Delivery(props: {
  readonly message: MessageProjection;
  readonly onRetry?: ((localSendId: number) => void) | undefined;
}) {
  if (props.message.delivery === "optimistic")
    return <Line class={styles.pending}>{t("messages.delivery.sending")}</Line>;
  if (props.message.delivery === "failed") {
    const localSendId = props.message.local_send_id;
    return localSendId === null || props.onRetry === undefined ? (
      <Line class={styles.failed}>{t("messages.delivery.failed")}</Line>
    ) : (
      <button
        class={`${styles.failed} ${styles.retry}`}
        onClick={() => props.onRetry?.(localSendId)}
        type="button"
      >
        {t("messages.delivery.failed_retry")}
      </button>
    );
  }
  return null;
}

function hasUnreadAfter(
  messages: readonly MessageProjection[],
  readAtMs: number | null,
): boolean {
  return unreadStartId(messages, readAtMs) !== undefined;
}

function timelineRows(
  messages: readonly MessageProjection[],
  memberships: readonly MembershipProjection[],
  readAtMs: number | null,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let day = "";
  let newInserted = false;
  const firstUnread = unreadStartId(messages, readAtMs);
  const items = [
    ...messages.map((value) => ({
      kind: "message" as const,
      value,
      time: messageTime(value),
    })),
    ...memberships.map((value) => ({
      kind: "membership" as const,
      value,
      time: value.server_time_ms ?? value.received_at_ms,
    })),
  ].sort(
    (left, right) => left.time - right.time || left.value.id - right.value.id,
  );
  for (const item of items) {
    const time = new Date(item.time);
    const nextDay = `${time.getFullYear()}-${time.getMonth()}-${time.getDate()}`;
    if (nextDay !== day) {
      day = nextDay;
      rows.push({ kind: "day", key: `day-${day}`, label: formatDay(time) });
    }
    if (
      !newInserted &&
      item.kind === "message" &&
      item.value.id === firstUnread
    ) {
      rows.push({ kind: "new", key: `new-before-${firstUnread}` });
      newInserted = true;
    }
    if (item.kind === "message")
      rows.push({
        kind: "message",
        key: `message-${item.value.id}`,
        message: item.value,
      });
    else
      rows.push({
        kind: "membership",
        key: `membership-${item.value.id}`,
        membership: item.value,
      });
  }
  return rows;
}

function unreadStartId(
  messages: readonly MessageProjection[],
  readAtMs: number | null,
): number | undefined {
  if (readAtMs === null) return undefined;
  const ordered = [...messages].sort(
    (left, right) =>
      messageTime(left) - messageTime(right) || left.id - right.id,
  );
  const effectiveReadAt = ordered.reduce(
    (current, message) =>
      message.authorship === "own" &&
      !isNoticeMessage(message) &&
      (message.delivery === "received" || message.delivery === "confirmed")
        ? Math.max(current, messageTime(message))
        : current,
    readAtMs,
  );
  return ordered.find(
    (message) =>
      message.authorship !== "own" && messageTime(message) > effectiveReadAt,
  )?.id;
}

function latestMessageTime(
  messages: readonly MessageProjection[],
): number | undefined {
  return messages.reduce<number | undefined>((latest, message) => {
    const time = messageTime(message);
    return latest === undefined ? time : Math.max(latest, time);
  }, undefined);
}

function formatDay(time: Date): string {
  const today = new Date();
  if (time.toDateString() === today.toDateString())
    return t("messages.date.today");
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (time.toDateString() === yesterday.toDateString())
    return t("messages.date.yesterday");
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    time,
  );
}

function messageTime(message: MessageProjection): number {
  if (isNoticeMessage(message)) return message.received_at_ms;
  return message.server_time_ms ?? message.received_at_ms;
}

function formatNoticeTime(milliseconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(milliseconds);
}
function bottomOffset(
  viewportHeight: number,
  contentHeight: number,
  typingSlotHeight: number,
): number {
  return Math.max(0, viewportHeight - contentHeight - typingSlotHeight);
}

function measureRowElement(
  element: HTMLLIElement,
  entry: ResizeObserverEntry | undefined,
  instance: Parameters<typeof measureElement<HTMLLIElement>>[2],
): number {
  const borderBox = entry?.borderBoxSize[0];
  if (borderBox !== undefined) {
    const size = instance.options.horizontal
      ? borderBox.inlineSize
      : borderBox.blockSize;
    if (size > 0) return size;
  }
  return measureElement(element, entry, instance);
}

function membershipArrow(
  kind: Extract<MembershipProjection, { type: "change" }>["kind"],
): string {
  return kind === "joined" ? "→" : "←";
}

function membershipVerb(
  kind: Extract<MembershipProjection, { type: "change" }>["kind"],
): string {
  if (kind === "joined") return t("messages.membership.joined");
  if (kind === "parted") return t("messages.membership.left");
  return t("messages.membership.quit");
}

function kickText(
  membership: Extract<MembershipProjection, { type: "kicked" }>,
): string {
  const reason = membership.reason === null ? "" : `: ${membership.reason}`;
  return t("messages.membership.kicked", {
    actor: membership.actor,
    reason,
  });
}

function formatNicks(nicks: readonly string[]): string {
  if (nicks.length < 2) return nicks[0] ?? "";
  if (nicks.length === 2)
    return t("messages.membership.two", {
      first: nicks[0] ?? "",
      last: nicks[1] ?? "",
    });
  return t("messages.membership.many", {
    members: nicks.slice(0, -1).join(", "),
    last: nicks.at(-1) ?? "",
  });
}

function toCopyRows(rows: readonly TimelineRow[]): CopyRow[] {
  const result: CopyRow[] = [];
  for (const row of rows) {
    if (row.kind === "day")
      result.push({ kind: "day-divider", label: row.label });
    if (row.kind === "membership")
      result.push({
        kind: "membership",
        text:
          row.membership.type === "kicked"
            ? `← ${kickText(row.membership)}`
            : `${membershipArrow(row.membership.kind)} ${formatNicks(row.membership.nicks)} ${membershipVerb(row.membership.kind)}`,
      });
    if (row.kind === "message" && row.message.kind === "action")
      result.push({
        kind: "action",
        author: row.message.author,
        text: row.message.text,
      });
    if (row.kind === "message" && row.message.kind === "text")
      result.push({
        kind: "message",
        time: new Date(messageTime(row.message)),
        author: row.message.author,
        text: row.message.text,
      });
    if (row.kind === "message" && isNoticeMessage(row.message))
      result.push({ kind: "membership", text: noticeText(row.message) });
  }
  return result;
}

function noticeText(message: NoticeMessage): string {
  const notice = message.kind.notice;
  switch (notice.type) {
    case "info":
      return message.text;
    case "topic": {
      const topic = message.text || t("messages.topic.empty");
      const setter =
        notice.setter === null || notice.setter === ""
          ? ""
          : t("messages.topic.setter", { setter: notice.setter });
      const time =
        notice.set_at === null ? "" : ` · ${formatNoticeTime(notice.set_at)}`;
      return t("messages.topic", { topic, setter, time });
    }
    default:
      return assertNever(notice);
  }
}

function isNoticeMessage(message: MessageProjection): message is NoticeMessage {
  return typeof message.kind === "object";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled notice kind: ${String(value)}`);
}
