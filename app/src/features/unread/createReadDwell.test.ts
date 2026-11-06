import { render } from "@solidjs/testing-library";
import { createMemo, createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MessageProjection } from "../../engine/protocol";
import { createReadDwell, newestCommittedMessageId } from "./createReadDwell";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("marks the newest server time when catch-up appends behind live traffic", () => {
  const newerLive: MessageProjection = {
    id: 9,
    author: "bender",
    text: "newer live arrival",
    kind: "text",
    bot: true,
    authorship: "other",
    nick_color_index: 0,
    highlighted: false,
    delivery: "received",
    local_send_id: null,
    server_ids: ["live-2"],
    server_time_ms: 2_000,
    received_at_ms: 2_100,
  };
  const olderCatchup: MessageProjection = {
    ...newerLive,
    id: 8,
    text: "missed while away",
    server_ids: ["missed-1"],
    server_time_ms: 1_000,
    received_at_ms: 2_200,
  };
  const localNotice: MessageProjection = {
    ...newerLive,
    id: 10,
    text: "reconnecting",
    kind: { notice: { type: "info" } },
    authorship: "own",
    server_ids: [],
    server_time_ms: null,
    received_at_ms: 3_000,
  };

  expect(newestCommittedMessageId([newerLive, olderCatchup, localNotice])).toBe(
    9,
  );
});

it("keeps the dwell armed across equal read-state snapshots", () => {
  const [snapshot, setSnapshot] = createSignal({
    bufferId: 2,
    messageId: 8,
    unread: 1,
  });
  const markRead = vi.fn();

  render(() => {
    createReadDwell({
      atLiveEdge: () => true,
      bufferId: createMemo(() => snapshot().bufferId),
      foreground: () => true,
      newestCommittedMessageId: createMemo(() => snapshot().messageId),
      onMarkRead: markRead,
      unread: createMemo(() => snapshot().unread),
    });
    return undefined;
  });

  vi.advanceTimersByTime(300);
  setSnapshot({ ...snapshot() });
  vi.advanceTimersByTime(200);

  expect(markRead).toHaveBeenCalledOnce();
  expect(markRead).toHaveBeenCalledWith(2, 8);
});

it("keeps the dwell across a newer committed message", () => {
  const [messageId, setMessageId] = createSignal(8);
  const markRead = vi.fn();

  render(() => {
    createReadDwell({
      atLiveEdge: () => true,
      bufferId: () => 2,
      foreground: () => true,
      newestCommittedMessageId: messageId,
      onMarkRead: markRead,
      unread: () => 1,
    });
    return undefined;
  });

  vi.advanceTimersByTime(300);
  setMessageId(9);
  vi.advanceTimersByTime(199);
  expect(markRead).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(markRead).toHaveBeenCalledWith(2, 9);
});

it("marks later arrivals immediately while the dwell remains qualified", () => {
  const [messageId, setMessageId] = createSignal(8);
  const [unread, setUnread] = createSignal(1);
  const markRead = vi.fn();

  render(() => {
    createReadDwell({
      atLiveEdge: () => true,
      bufferId: () => 2,
      foreground: () => true,
      newestCommittedMessageId: messageId,
      onMarkRead: markRead,
      unread,
    });
    return undefined;
  });

  vi.advanceTimersByTime(500);
  expect(markRead).toHaveBeenLastCalledWith(2, 8);
  setUnread(0);
  setMessageId(9);
  setUnread(1);
  expect(markRead).toHaveBeenLastCalledWith(2, 9);
  expect(markRead).toHaveBeenCalledTimes(2);
});

it("cancels the dwell when the conversation stops qualifying", () => {
  const [foreground, setForeground] = createSignal(true);
  const markRead = vi.fn();

  render(() => {
    createReadDwell({
      atLiveEdge: () => true,
      bufferId: () => 2,
      foreground,
      newestCommittedMessageId: () => 8,
      onMarkRead: markRead,
      unread: () => 1,
    });
    return undefined;
  });

  vi.advanceTimersByTime(300);
  setForeground(false);
  vi.advanceTimersByTime(500);
  expect(markRead).not.toHaveBeenCalled();
});
