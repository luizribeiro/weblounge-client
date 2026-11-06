import { render } from "@solidjs/testing-library";
import { createMemo, createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createReadDwell } from "./createReadDwell";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

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
