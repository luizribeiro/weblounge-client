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
import { densityPresets } from "../../density/density";
import type {
  BufferProjection,
  HistoryState,
  MembershipProjection,
  MessageProjection,
  NoticeKind,
} from "../../engine/protocol";
import { keyboardMotionTranscriptRevealEvent } from "../../platform/keyboard-motion";
import {
  type AppGeometryChange,
  appGeometryChangeEvent,
} from "../../platform/viewport-geometry";
import { t } from "../../strings";
import { BotIcon } from "../../ui/BotIcon";
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
import styles from "./MessageList.module.css";
import { MessageText, Nickname } from "./MessageText";
import {
  currentMessageDensity,
  estimateMessageHeight,
  messageSizeRevision,
} from "./message-size-estimate";
import { startsMobileMessageGroup } from "./mobile-message-group";
import { nickColor } from "./nick-color";
import { createNickLookup, type NickDisplay } from "./nick-lookup";
import { ReactionChips } from "./ReactionChips";

interface MessageListProps {
  readonly bufferId?: number | undefined;
  readonly foreground?: boolean | undefined;
  readonly foregroundExitEpoch?: number | undefined;
  readonly historyState?: HistoryState | undefined;
  readonly presentation?: "desktop" | "mobile" | undefined;
  readonly messages: readonly MessageProjection[];
  readonly memberships?: readonly MembershipProjection[] | undefined;
  readonly readAtMs?: number | null | undefined;
  readonly syncState?: BufferProjection["sync_state"] | undefined;
  readonly unread?: number | undefined;
  readonly onLiveEdgeChange?: (atLiveEdge: boolean) => void;
  readonly onLoadOlder?: (() => void) | undefined;
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
  | {
      readonly kind: "history";
      readonly key: string;
      readonly state: HistoryState;
    }
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
      readonly startsMobileGroup: boolean;
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
  const estimatedSizes = new Map<
    string,
    { readonly revision: string; readonly size: number }
  >();
  let renderedCount = 0;
  let currentBuffer = props.bufferId;
  const initialReadAt = dividerMarkAfterOwnSend(
    props.readAtMs ?? null,
    props.messages,
  );
  let dividerTracksMark = !openingBoundaryPending(
    props.messages,
    initialReadAt,
    props.syncState,
    props.unread,
  );
  let observedForegroundExitEpoch = props.foregroundExitEpoch;
  let watchedThrough: number | undefined;
  let observedOwnTime = latestCommittedOwnTime(props.messages);
  let observedPeerTime = latestPeerTime(props.messages);
  let logicallyAtLiveEdge = true;
  let scrollLiveEdgeFrame: number | undefined;
  let olderPageArmed = true;
  let historyWasLoading = props.historyState?.loading === true;
  const [dividerMark, setDividerMark] = createSignal(initialReadAt);
  const [publishedAtLiveEdge, setPublishedAtLiveEdge] = createSignal(true);
  const [unseen, setUnseen] = createSignal(0);
  const [selectedMessage, setSelectedMessage] = createSignal<number>();
  const [viewportHeight, setViewportHeight] = createSignal(768);
  const rows = createMemo(() =>
    timelineRows(
      props.messages,
      props.memberships ?? [],
      dividerMark(),
      props.historyState,
    ),
  );
  const rowSizeRevision = (row: TimelineRow) =>
    row.kind === "message"
      ? messageSizeRevision(
          row.message,
          props.presentation === "mobile" ? row.startsMobileGroup : undefined,
        )
      : row.key;
  // TanStack rebuilds its index-keyed measurements only when the row count or
  // the key extractor's identity changes, and a moving divider keeps the count.
  const rowKey = createMemo(() => {
    const current = rows();
    return (index: number) => current[index]?.key ?? index;
  });
  const nickLookup = createMemo(() => createNickLookup(props.messages));
  const setLiveEdge = (live: boolean) => {
    if (scrollLiveEdgeFrame !== undefined) {
      window.cancelAnimationFrame(scrollLiveEdgeFrame);
      scrollLiveEdgeFrame = undefined;
    }
    logicallyAtLiveEdge = live;
    setPublishedAtLiveEdge(live);
    if (live) setUnseen(0);
    props.onLiveEdgeChange?.(live);
  };
  const deferScrollLiveEdge = (live: boolean) => {
    // Arrivals must observe the user's position immediately, while reactive
    // publication waits because it can rewrite virtual transcript geometry.
    logicallyAtLiveEdge = live;
    if (scrollLiveEdgeFrame !== undefined) return;
    scrollLiveEdgeFrame = window.requestAnimationFrame(() => {
      scrollLiveEdgeFrame = undefined;
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
  const requestOlderAtTop = () => {
    if (!olderPageArmed) return;
    props.onLoadOlder?.();
    olderPageArmed = false;
  };
  createEffect(() => {
    const history = props.historyState;
    if (
      historyWasLoading &&
      history?.loading === false &&
      history.at_start === false
    )
      olderPageArmed = true;
    historyWasLoading = history?.loading === true;
  });
  const markWheelScrollIntent = (event: WheelEvent) => {
    userScrollIntent.beginDiscrete();
    if (event.deltaY < 0 && (list?.scrollTop ?? Infinity) <= liveEdgeTolerance)
      requestOlderAtTop();
  };
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
        if (followEnd) scrollToLiveEdge();
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
      if (row?.kind !== "message")
        return estimateDecorationHeight(row?.kind, estimatedDensity);
      const width =
        observedWidth ?? (props.presentation === "mobile" ? 402 : 1024);
      const cached = estimatedSizes.get(row.key);
      const revision = rowSizeRevision(row);
      if (cached?.revision === revision) return cached.size;
      const estimated = estimateMessageHeight(
        row.message,
        width,
        estimatedDensity,
        props.presentation,
        row.startsMobileGroup,
      );
      estimatedSizes.set(row.key, { revision, size: estimated });
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
  const scrollToLiveEdge = () => {
    if (list === undefined) return;
    if (list.scrollHeight <= list.clientHeight + liveEdgeTolerance) {
      virtualizer.cancelScroll();
      return;
    }
    virtualizer.scrollToEnd();
  };
  const refreshRenderedMeasurements = () => {
    if (list?.isConnected !== true) return;
    const measurements = [
      ...list.querySelectorAll<HTMLLIElement>("li[data-index]"),
    ].flatMap((element) => {
      const index = Number(element.dataset.index);
      const size =
        element.getBoundingClientRect().height || element.offsetHeight;
      return Number.isInteger(index) && size > 0 ? [{ index, size }] : [];
    });
    preserveVisualScrollAnchor(list, () => {
      for (const { index, size } of measurements)
        virtualizer.resizeItem(index, size);
    });
  };
  const remeasure = () => {
    if (list?.isConnected !== true) return;
    const elements = [
      ...list.querySelectorAll<HTMLLIElement>("li[data-index]"),
    ];
    const measurements = elements.flatMap((element) => {
      const index = Number(element.dataset.index);
      const size =
        element.getBoundingClientRect().height || element.offsetHeight;
      return Number.isInteger(index) && size > 0 ? [{ index, size }] : [];
    });
    preserveVisualScrollAnchor(list, () => {
      virtualizer.measure();
      for (const { index, size } of measurements)
        virtualizer.resizeItem(index, size);
      for (const element of elements) virtualizer.measureElement(element);
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
    scrollToLiveEdge();
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
      const marker = dividerMarkAfterOwnSend(
        props.readAtMs ?? null,
        props.messages,
      );
      setDividerMark(marker);
      dividerTracksMark = !openingBoundaryPending(
        props.messages,
        marker,
        props.syncState,
        props.unread,
      );
      observedForegroundExitEpoch = props.foregroundExitEpoch;
      watchedThrough = undefined;
      observedOwnTime = latestCommittedOwnTime(props.messages);
      observedPeerTime = latestPeerTime(props.messages);
      renderedCount = 0;
      olderPageArmed = true;
      setUnseen(0);
      setLiveEdge(true);
      scrollToLiveEdge();
    }
  });
  createEffect(() => {
    const marker = props.readAtMs ?? null;
    const foregroundExitEpoch = props.foregroundExitEpoch;
    if (foregroundExitEpoch !== observedForegroundExitEpoch) {
      if (dividerTracksMark) setDividerMark(maximumMark(dividerMark(), marker));
      dividerTracksMark = false;
      watchedThrough = undefined;
      observedForegroundExitEpoch = foregroundExitEpoch;
    }
    if (
      props.messages.length === 0 &&
      props.syncState !== "syncing" &&
      (props.unread ?? 0) === 0
    )
      dividerTracksMark = true;
    const ownTime = latestCommittedOwnTime(props.messages);
    const peerTime = latestPeerTime(props.messages);
    if (
      ownTime !== undefined &&
      (observedOwnTime === undefined || ownTime > observedOwnTime)
    ) {
      const ownMark = Math.max(marker ?? ownTime, ownTime);
      setDividerMark(ownMark);
      dividerTracksMark =
        !hasUnreadAfter(props.messages, ownMark) ||
        (peerTime !== undefined &&
          (observedPeerTime === undefined || peerTime > observedPeerTime));
      watchedThrough = undefined;
    }
    observedOwnTime = ownTime;
    observedPeerTime = peerTime;
    if (dividerMark() === null && marker !== null) {
      setDividerMark(marker);
      dividerTracksMark = !openingBoundaryPending(
        props.messages,
        marker,
        props.syncState,
        props.unread,
      );
      watchedThrough = undefined;
      return;
    }
    const reading =
      props.foreground !== false &&
      publishedAtLiveEdge() &&
      logicallyAtLiveEdge;
    if (!reading) {
      if (dividerTracksMark) setDividerMark(maximumMark(dividerMark(), marker));
      dividerTracksMark = false;
      watchedThrough = undefined;
      return;
    }
    if (
      watchedThrough !== undefined &&
      marker !== null &&
      marker >= watchedThrough
    ) {
      dividerTracksMark = true;
      watchedThrough = undefined;
    }
    if (watchedThrough !== undefined) {
      const watched = latestMessageTime(props.messages);
      if (watched !== undefined && watched > watchedThrough) {
        setDividerMark(watched);
        watchedThrough = watched;
      }
      return;
    }
    if (!dividerTracksMark) return;
    const current = dividerMark();
    if (hasUnreadAfter(props.messages, current)) {
      const watched = latestMessageTime(props.messages);
      setDividerMark(watched ?? current);
      dividerTracksMark = false;
      watchedThrough = watched;
    } else {
      setDividerMark(maximumMark(current, marker));
    }
  });
  createEffect(() => {
    const messages = props.messages;
    const previousCount = renderedCount;
    if (messages.length > previousCount && !logicallyAtLiveEdge)
      setUnseen((count) => count + messages.length - previousCount);
    renderedCount = messages.length;
    if (messages.length !== previousCount && logicallyAtLiveEdge)
      scrollToLiveEdge();
  });
  let measuredRows = rows().map((row) => ({
    key: row.key,
    revision: rowSizeRevision(row),
  }));
  createEffect(() => {
    const currentRows = rows();
    const currentMeasurements = currentRows.map((row) => ({
      key: row.key,
      revision: rowSizeRevision(row),
    }));
    const unchanged =
      currentMeasurements.length === measuredRows.length &&
      measuredRows.every(
        (row, index) =>
          currentMeasurements[index]?.key === row.key &&
          currentMeasurements[index]?.revision === row.revision,
      );
    if (unchanged) return;
    const appended =
      currentMeasurements.length > measuredRows.length &&
      measuredRows.every(
        (row, index) =>
          currentMeasurements[index]?.key === row.key &&
          currentMeasurements[index]?.revision === row.revision,
      );
    measuredRows = currentMeasurements;
    queueMicrotask(() => {
      if (!appended) remeasure();
      if (logicallyAtLiveEdge) scrollToLiveEdge();
    });
  });
  onMount(() => {
    props.onLiveEdgeChange?.(logicallyAtLiveEdge);
    const fonts = document.fonts;
    const composerOwner = list?.parentElement?.parentElement;
    const anchorComposerGeometry = () => {
      syncViewportRect?.();
    };
    const settleKeyboardMotionTranscript = () => {
      // The keyboard commit scroll is still active here, so TanStack skips
      // measureElement. Keep unrendered measurements and update painted rows
      // directly before the frozen snapshot leaves.
      refreshRenderedMeasurements();
      if (logicallyAtLiveEdge) scrollToLiveEdge();
    };
    const cancelComposerScroll = () => {
      if (logicallyAtLiveEdge) virtualizer.cancelScroll();
    };
    const handleFontsLoaded = () => {
      remeasure();
      if (logicallyAtLiveEdge) scrollToLiveEdge();
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
        if (!followedResizedViewport) scrollToLiveEdge();
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
    list?.addEventListener(
      keyboardMotionTranscriptRevealEvent,
      settleKeyboardMotionTranscript,
    );
    fonts?.addEventListener("loadingdone", handleFontsLoaded);
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
      list?.removeEventListener(
        keyboardMotionTranscriptRevealEvent,
        settleKeyboardMotionTranscript,
      );
      fonts?.removeEventListener("loadingdone", handleFontsLoaded);
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
          if (element.scrollTop <= liveEdgeTolerance) {
            requestOlderAtTop();
          } else {
            olderPageArmed = true;
          }
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
                      transform: `translateY(${virtualRow.start + bottomOffset(viewportHeight(), virtualizer.getTotalSize())}px)`,
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
                      presentation={props.presentation}
                      row={row()}
                    />
                  </li>
                );
              }}
            </For>
          </ol>
        </div>
      </div>
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
  readonly presentation?: "desktop" | "mobile" | undefined;
  readonly row: TimelineRow | undefined;
}) {
  return (
    <Show when={props.row} keyed>
      {(row) => (
        <Switch>
          <Match when={row.kind === "history"}>
            <div class={styles.divider} data-history-edge="true">
              <span>
                {row.kind === "history" && row.state.loading
                  ? t("messages.history.loading")
                  : t("messages.history.start")}
              </span>
            </div>
          </Match>
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
                presentation={props.presentation}
                startsMobileGroup={row.startsMobileGroup}
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
  readonly presentation?: "desktop" | "mobile" | undefined;
  readonly startsMobileGroup: boolean;
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
      class={`${styles.row} ${message.highlighted ? styles.highlighted : ""} ${message.unverified_sender === true ? styles.unverified : ""} ${message.kind === "action" ? styles.action : ""} ${message.kind === "irc_notice" ? styles.ircNotice : ""}`}
      data-delivery={message.delivery}
      data-irc-notice={message.kind === "irc_notice" || undefined}
      data-message-row="true"
      data-message-group-start={props.startsMobileGroup ? "true" : "false"}
      data-message-text={message.text}
      data-unverified-sender={message.unverified_sender === true || undefined}
    >
      {message.kind === "action" ? (
        <>
          <div class={styles.actionContent}>
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
            <div class={styles.actionReactions}>
              <ReactionChips
                presentation={props.presentation}
                reactions={message.reactions}
              />
            </div>
          </div>
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
              <BotIcon
                class={styles.botIcon}
                color={
                  message.authorship === "own"
                    ? "var(--wl-color-self-nick)"
                    : nickColor(message.nick_color_index)
                }
              />
            )}
            <UnverifiedSenderMark message={message} />
          </Line>
          <div class={styles.content}>
            <Selectable class={styles.text} surfaceId={`message-${message.id}`}>
              <MessageText
                authors={props.nickLookup}
                onOpenChannel={props.onOpenChannel}
                onOpenDirect={props.onOpenDirect}
                onOpenExternal={props.onOpenExternal}
                text={message.text}
              />
            </Selectable>
            <ReactionChips
              presentation={props.presentation}
              reactions={message.reactions}
            />
          </div>
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

function openingBoundaryPending(
  messages: readonly MessageProjection[],
  readAtMs: number | null,
  syncState: BufferProjection["sync_state"] | undefined,
  unread: number | undefined,
): boolean {
  return (
    (unread ?? 0) > 0 ||
    hasUnreadAfter(messages, readAtMs) ||
    (readAtMs !== null && messages.length === 0 && syncState === "syncing")
  );
}

function timelineRows(
  messages: readonly MessageProjection[],
  memberships: readonly MembershipProjection[],
  readAtMs: number | null,
  historyState?: HistoryState,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  if (historyState?.loading === true || historyState?.at_start === true) {
    rows.push({ kind: "history", key: "history-edge", state: historyState });
  }
  let day = "";
  let newInserted = false;
  let previousGroupMessage: MessageProjection | undefined;
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
      previousGroupMessage = undefined;
    }
    if (
      !newInserted &&
      item.kind === "message" &&
      item.value.id === firstUnread
    ) {
      rows.push({ kind: "new", key: `new-before-${firstUnread}` });
      newInserted = true;
      previousGroupMessage = undefined;
    }
    if (item.kind === "message") {
      rows.push({
        kind: "message",
        key: `message-${item.value.id}`,
        message: item.value,
        startsMobileGroup: startsMobileMessageGroup(
          previousGroupMessage,
          item.value,
        ),
      });
      previousGroupMessage =
        item.value.kind === "text" ? item.value : undefined;
    } else {
      rows.push({
        kind: "membership",
        key: `membership-${item.value.id}`,
        membership: item.value,
      });
      previousGroupMessage = undefined;
    }
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
  return ordered.find(
    (message) =>
      message.authorship !== "own" && messageTime(message) > readAtMs,
  )?.id;
}

function latestCommittedOwnTime(
  messages: readonly MessageProjection[],
): number | undefined {
  return messages.reduce<number | undefined>((latest, message) => {
    if (
      message.authorship !== "own" ||
      isNoticeMessage(message) ||
      (message.delivery !== "received" && message.delivery !== "confirmed")
    ) {
      return latest;
    }
    const time = messageTime(message);
    return latest === undefined ? time : Math.max(latest, time);
  }, undefined);
}

function latestPeerTime(
  messages: readonly MessageProjection[],
): number | undefined {
  return messages.reduce<number | undefined>((latest, message) => {
    if (message.authorship === "own" || isNoticeMessage(message)) return latest;
    const time = messageTime(message);
    return latest === undefined ? time : Math.max(latest, time);
  }, undefined);
}

function dividerMarkAfterOwnSend(
  readAtMs: number | null,
  messages: readonly MessageProjection[],
): number | null {
  const ownTime = latestCommittedOwnTime(messages);
  return ownTime === undefined
    ? readAtMs
    : Math.max(readAtMs ?? ownTime, ownTime);
}

function maximumMark(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
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
function bottomOffset(viewportHeight: number, contentHeight: number): number {
  return Math.max(0, viewportHeight - contentHeight);
}

function estimateDecorationHeight(
  kind: Exclude<TimelineRow["kind"], "message"> | undefined,
  density: ReturnType<typeof currentMessageDensity>,
): number {
  const preset = densityPresets[density];
  const padding =
    kind === "membership"
      ? preset.mobileContinuationPadding
      : preset.mobileGroupTopPadding;
  return 18 + Number.parseFloat(padding);
}

function measureRowElement(
  element: HTMLLIElement,
  entry: ResizeObserverEntry | undefined,
  instance: Parameters<typeof measureElement<HTMLLIElement>>[2],
): number {
  const bounds = element.getBoundingClientRect();
  const renderedSize = instance.options.horizontal
    ? bounds.width
    : bounds.height;
  if (renderedSize > 0) return renderedSize;
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

function toCopyRows(rows: readonly TimelineRow[]): (CopyRow | undefined)[] {
  return rows.map((row) => {
    if (row.kind === "day") return { kind: "day-divider", label: row.label };
    if (row.kind === "membership")
      return {
        kind: "membership",
        text:
          row.membership.type === "kicked"
            ? `← ${kickText(row.membership)}`
            : `${membershipArrow(row.membership.kind)} ${formatNicks(row.membership.nicks)} ${membershipVerb(row.membership.kind)}`,
      };
    if (row.kind === "message" && row.message.kind === "action")
      return {
        kind: "action",
        author: row.message.author,
        text: row.message.text,
      };
    if (
      row.kind === "message" &&
      (row.message.kind === "text" || row.message.kind === "irc_notice")
    )
      return {
        kind: "message",
        time: new Date(messageTime(row.message)),
        author: row.message.author,
        text: row.message.text,
      };
    if (row.kind === "message" && isNoticeMessage(row.message))
      return { kind: "membership", text: noticeText(row.message) };
    return undefined;
  });
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
