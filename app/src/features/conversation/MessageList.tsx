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
} from "../../engine/protocol";
import type { CopyRow } from "../../ui/copy-rows";
import { copySelectedRows } from "../../ui/copy-selection";
import { formatTime, formattedTimeColumnWidth } from "../../ui/format-time";
import { Line } from "../../ui/Line";
import { Selectable } from "../../ui/Selectable";
import styles from "./MessageList.module.css";
import { MessageText } from "./MessageText";
import {
  currentMessageDensity,
  estimateMessageHeight,
} from "./message-size-estimate";
import { nickColor } from "./nick-color";
import { createNickLookup, type NickDisplay } from "./nick-lookup";

interface MessageListProps {
  readonly bufferId?: number | undefined;
  readonly presentation?: "desktop" | "mobile" | undefined;
  readonly messages: readonly MessageProjection[];
  readonly memberships?: readonly MembershipProjection[] | undefined;
  readonly readThrough?: number | null | undefined;
  readonly onLiveEdgeChange?: (atLiveEdge: boolean) => void;
  readonly onOpenChannel?: ((channel: string) => void) | undefined;
  readonly onOpenExternal?: ((href: string) => void) | undefined;
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

const liveEdgeTolerance = 2;

export function MessageList(props: MessageListProps) {
  let list: HTMLOListElement | undefined;
  let liveEdgeSentinel: HTMLDivElement | undefined;
  let observedWidth: number | undefined;
  let observedHeight: number | undefined;
  let renderedCount = 0;
  let currentBuffer = props.bufferId;
  const initialReadThrough = props.readThrough ?? null;
  let boundaryFrozen =
    initialReadThrough !== null &&
    props.messages.some((message) => message.id > initialReadThrough);
  const [frozenReadThrough, setFrozenReadThrough] = createSignal(
    props.readThrough ?? null,
  );
  const [atLiveEdge, setAtLiveEdge] = createSignal(true);
  const [unseen, setUnseen] = createSignal(0);
  const [selectedMessage, setSelectedMessage] = createSignal<number>();
  const rows = createMemo(() =>
    timelineRows(props.messages, props.memberships ?? [], frozenReadThrough()),
  );
  const nickLookup = createMemo(() => createNickLookup(props.messages));
  const setLiveEdge = (live: boolean) => {
    if (!live && atLiveEdge() && !boundaryFrozen) {
      const lastSeen = props.messages.at(-1)?.id;
      if (lastSeen !== undefined) {
        boundaryFrozen = true;
        setFrozenReadThrough(lastSeen);
      }
    }
    setAtLiveEdge(live);
    if (live) setUnseen(0);
    props.onLiveEdgeChange?.(live);
  };
  const virtualizer = createVirtualizer<HTMLOListElement, HTMLLIElement>({
    get count() {
      return rows().length;
    },
    getScrollElement: () => list ?? null,
    initialRect: { width: 1024, height: 768 },
    observeElementRect: (instance, callback) =>
      observeElementRect(instance, (rect) => {
        const next = rect.height === 0 ? { width: 1024, height: 768 } : rect;
        const widthChanged =
          observedWidth !== undefined && observedWidth !== next.width;
        const viewportChanged =
          (observedWidth !== undefined && observedWidth !== next.width) ||
          (observedHeight !== undefined && observedHeight !== next.height);
        const followEnd = viewportChanged && atLiveEdge();
        observedWidth = next.width;
        observedHeight = next.height;
        callback(next);
        if (widthChanged) remeasure();
        if (followEnd) virtualizer.scrollToEnd();
      }),
    estimateSize: (index) => {
      const row = rows()[index];
      if (row?.kind !== "message") return 34;
      const width =
        list !== undefined && list.clientWidth > 0
          ? list.clientWidth
          : props.presentation === "mobile"
            ? 402
            : 1024;
      return estimateMessageHeight(
        row.message,
        width,
        currentMessageDensity(document.documentElement),
      );
    },
    getItemKey: (index) => rows()[index]?.key ?? index,
    measureElement: (element, entry, instance) => {
      const index = Number(element.dataset.index);
      const measured = measureElement(element, entry, instance);
      const size =
        measured > 0 ? measured : instance.options.estimateSize(index);
      return size;
    },
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: liveEdgeTolerance,
    // The sentinel can report before the virtualizer has seen the scroll that
    // reached the end, and stays visible afterwards, so arrival at the end is
    // also taken from the virtualizer. Leaving stays sentinel-driven so a
    // transient gap during an append cannot freeze the read boundary.
    onChange: (instance) => {
      if (!atLiveEdge() && instance.isAtEnd()) setLiveEdge(true);
    },
    overscan: 6,
  });
  const remeasure = () => {
    if (list?.isConnected !== true) return;
    virtualizer.measure();
    for (const element of list.querySelectorAll<HTMLLIElement>(
      "li[data-index]",
    ))
      virtualizer.measureElement(element);
  };
  const measureRow = (element: HTMLLIElement, index: number) => {
    element.dataset.index = String(index);
    const measured = measureElement(element, undefined, virtualizer);
    if (measured > 0) virtualizer.resizeItem(index, measured);
    virtualizer.measureElement(element);
  };
  const reportLiveEdge = (sentinelVisible: boolean) =>
    setLiveEdge(sentinelVisible && virtualizer.isAtEnd());
  const jumpToBottom = () => {
    if (list === undefined || rows().length === 0) return;
    virtualizer.scrollToEnd();
  };
  const selectLastOwn = () => {
    const message = [...props.messages]
      .reverse()
      .find((item) => item.authorship === "own" && item.kind !== "notice");
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
      setFrozenReadThrough(props.readThrough ?? null);
      boundaryFrozen = false;
      renderedCount = 0;
      setUnseen(0);
    }
  });
  createEffect(() => {
    const marker = props.readThrough ?? null;
    const hasUnread =
      marker !== null && props.messages.some((message) => message.id > marker);
    if (!boundaryFrozen) setFrozenReadThrough(marker);
    if (
      hasUnread &&
      (!atLiveEdge() || document.hidden || !document.hasFocus())
    ) {
      boundaryFrozen = true;
      setFrozenReadThrough(marker);
    }
  });
  createEffect(() => {
    const messages = props.messages;
    const previousCount = renderedCount;
    if (messages.length > previousCount && !atLiveEdge())
      setUnseen((count) => count + messages.length - previousCount);
    renderedCount = messages.length;
  });
  onMount(() => {
    const fonts = document.fonts;
    const handleFontsLoaded = () => {
      remeasure();
      if (atLiveEdge()) virtualizer.scrollToEnd();
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
    if (liveEdgeSentinel !== undefined)
      liveEdgeObserver?.observe(liveEdgeSentinel);
    void (fonts?.ready ?? Promise.resolve()).then(handleFontsLoaded);
    fonts?.addEventListener("loadingdone", handleFontsLoaded);
    onCleanup(() => {
      liveEdgeObserver?.disconnect();
      fonts?.removeEventListener("loadingdone", handleFontsLoaded);
    });
    queueMicrotask(jumpToBottom);
  });

  return (
    <div class={styles.surface}>
      <ol
        aria-label="Messages"
        class={styles.list}
        data-message-list="true"
        data-presentation={props.presentation ?? "desktop"}
        onKeyDown={(event) => {
          if (event.key !== "End") return;
          event.preventDefault();
          jumpToBottom();
        }}
        ref={(element) => {
          list = element;
        }}
        style={{ "--wl-message-time-column": formattedTimeColumnWidth() }}
        tabindex="0"
        onCopy={(event) =>
          copySelectedRows(event, event.currentTarget, toCopyRows(rows()))
        }
      >
        <div
          aria-hidden="true"
          class={styles.spacer}
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        />
        <div
          aria-hidden="true"
          class={styles.liveEdge}
          ref={(element) => {
            liveEdgeSentinel = element;
          }}
          style={{ top: `${Math.max(virtualizer.getTotalSize() - 1, 0)}px` }}
        />
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
                  transform: `translateY(${virtualRow.start + bottomOffset(virtualizer.scrollRect?.height ?? 0, virtualizer.getTotalSize())}px)`,
                }}
              >
                <TimelineRowView
                  index={virtualRow.index}
                  nickLookup={nickLookup()}
                  onOpenChannel={props.onOpenChannel}
                  onOpenExternal={props.onOpenExternal}
                  onRetry={props.onRetry}
                  row={row()}
                />
              </li>
            );
          }}
        </For>
      </ol>
      {unseen() > 0 && (
        <button class={styles.jump} onClick={jumpToBottom} type="button">
          {unseen()} new {unseen() === 1 ? "message" : "messages"} ↓
        </button>
      )}
    </div>
  );
}

function TimelineRowView(props: {
  readonly index: number;
  readonly nickLookup: ReadonlyMap<string, NickDisplay>;
  readonly onOpenChannel?: ((channel: string) => void) | undefined;
  readonly onOpenExternal?: ((href: string) => void) | undefined;
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
              <span>New</span>
            </div>
          </Match>
          <Match when={row.kind === "message"}>
            {row.kind === "message" && (
              <MessageRow
                index={props.index}
                message={row.message}
                nickLookup={props.nickLookup}
                onOpenChannel={props.onOpenChannel}
                onOpenExternal={props.onOpenExternal}
                onRetry={props.onRetry}
              />
            )}
          </Match>
          <Match when={row.kind === "membership"}>
            {row.kind === "membership" && (
              <div class={styles.membership} data-membership-row="true">
                {membershipArrow(row.membership.kind)}{" "}
                {formatNicks(row.membership.nicks)}{" "}
                {membershipVerb(row.membership.kind)}
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
  readonly onOpenExternal?: ((href: string) => void) | undefined;
  readonly onRetry?: ((localSendId: number) => void) | undefined;
}) {
  const message = props.message;
  if (message.kind === "notice")
    return (
      <NoticeRow
        message={message}
        nickLookup={props.nickLookup}
        onOpenChannel={props.onOpenChannel}
        onOpenExternal={props.onOpenExternal}
      />
    );
  const nickStyle =
    message.authorship === "own"
      ? undefined
      : { color: nickColor(message.nick_color_index) };
  return (
    <div
      class={`${styles.row} ${message.mentioned ? styles.mentioned : ""} ${message.kind === "action" ? styles.action : ""}`}
      data-delivery={message.delivery}
      data-message-row="true"
      data-message-text={message.text}
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
            <span class={styles.actionNick} style={nickStyle}>
              {message.author}
            </span>{" "}
            <MessageText
              authors={props.nickLookup}
              onOpenChannel={props.onOpenChannel}
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
            {message.mode_symbol !== null && (
              <span class={styles.mode}>{message.mode_symbol}</span>
            )}
            <span
              class={`${styles.nick} ${message.authorship === "own" ? styles.own : ""}`}
              style={nickStyle}
              title={message.author}
            >
              {message.author}
            </span>
            {message.bot && <span class={styles.bot}>BOT</span>}
          </Line>
          <Selectable class={styles.text} surfaceId={`message-${message.id}`}>
            <MessageText
              authors={props.nickLookup}
              onOpenChannel={props.onOpenChannel}
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

function NoticeRow(props: {
  readonly message: MessageProjection;
  readonly nickLookup: ReadonlyMap<string, NickDisplay>;
  readonly onOpenChannel?: ((channel: string) => void) | undefined;
  readonly onOpenExternal?: ((href: string) => void) | undefined;
}) {
  const message = props.message;
  return (
    <div
      class={styles.notice}
      data-message-row="true"
      data-message-text={message.text}
      data-notice-row="true"
    >
      <span>Topic: </span>
      <Selectable
        class={styles.noticeTopic}
        surfaceId={`message-${message.id}`}
      >
        {message.text === "" ? (
          "No topic is set."
        ) : (
          <MessageText
            authors={props.nickLookup}
            onOpenChannel={props.onOpenChannel}
            onOpenExternal={props.onOpenExternal}
            text={message.text}
          />
        )}
      </Selectable>
      {message.author !== "" && <span> — set by {message.author}</span>}
      {message.server_time_ms !== null && (
        <time dateTime={new Date(message.server_time_ms).toISOString()}>
          {" ·"}
          {formatNoticeTime(message.server_time_ms)}
        </time>
      )}
    </div>
  );
}

function Delivery(props: {
  readonly message: MessageProjection;
  readonly onRetry?: ((localSendId: number) => void) | undefined;
}) {
  if (props.message.delivery === "optimistic")
    return <Line class={styles.pending}>Sending…</Line>;
  if (props.message.delivery === "failed") {
    const localSendId = props.message.local_send_id;
    return localSendId === null || props.onRetry === undefined ? (
      <Line class={styles.failed}>Failed</Line>
    ) : (
      <button
        class={`${styles.failed} ${styles.retry}`}
        onClick={() => props.onRetry?.(localSendId)}
        type="button"
      >
        Failed · Retry
      </button>
    );
  }
  return null;
}

function timelineRows(
  messages: readonly MessageProjection[],
  memberships: readonly MembershipProjection[],
  readThrough: number | null,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let day = "";
  let newInserted = false;
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
      readThrough !== null &&
      item.kind === "message" &&
      item.value.id > readThrough
    ) {
      rows.push({ kind: "new", key: `new-after-${readThrough}` });
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

function formatDay(time: Date): string {
  const today = new Date();
  if (time.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (time.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    time,
  );
}

function messageTime(message: MessageProjection): number {
  if (message.kind === "notice") return message.received_at_ms;
  return message.server_time_ms ?? message.received_at_ms;
}

function formatNoticeTime(milliseconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(milliseconds);
}
function bottomOffset(viewportHeight: number, contentHeight: number): number {
  return Math.max(0, viewportHeight - contentHeight - 22);
}

function membershipArrow(kind: MembershipProjection["kind"]): string {
  return kind === "joined" ? "→" : "←";
}

function membershipVerb(kind: MembershipProjection["kind"]): string {
  if (kind === "joined") return "joined";
  if (kind === "parted") return "left";
  return "quit";
}

function formatNicks(nicks: readonly string[]): string {
  if (nicks.length < 2) return nicks[0] ?? "";
  if (nicks.length === 2) return `${nicks[0]} and ${nicks[1]}`;
  return `${nicks.slice(0, -1).join(", ")} and ${nicks.at(-1)}`;
}

function toCopyRows(rows: readonly TimelineRow[]): CopyRow[] {
  const result: CopyRow[] = [];
  for (const row of rows) {
    if (row.kind === "day")
      result.push({ kind: "day-divider", label: row.label });
    if (row.kind === "membership")
      result.push({
        kind: "membership",
        text: `${membershipArrow(row.membership.kind)} ${formatNicks(row.membership.nicks)} ${membershipVerb(row.membership.kind)}`,
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
    if (row.kind === "message" && row.message.kind === "notice")
      result.push({ kind: "membership", text: topicNoticeText(row.message) });
  }
  return result;
}

function topicNoticeText(message: MessageProjection): string {
  const topic = message.text || "No topic is set.";
  const setter = message.author === "" ? "" : ` — set by ${message.author}`;
  const time =
    message.server_time_ms === null
      ? ""
      : ` · ${formatNoticeTime(message.server_time_ms)}`;
  return `Topic: ${topic}${setter}${time}`;
}
