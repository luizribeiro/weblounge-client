import { render } from "@solidjs/testing-library";
import { batch, createMemo, createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MessageProjection } from "../../engine/protocol";
import { createReadDwell, newestCommittedMessageId } from "./createReadDwell";

const noForegroundExit = () => undefined;

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
      foregroundExitEpoch: noForegroundExit,
      newestCommittedMessageId: createMemo(() => snapshot().messageId),
      onMarkRead: markRead,
      visible: () => true,
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
      foregroundExitEpoch: noForegroundExit,
      newestCommittedMessageId: messageId,
      onMarkRead: markRead,
      visible: () => true,
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
  const markRead = vi.fn();

  render(() => {
    createReadDwell({
      atLiveEdge: () => true,
      bufferId: () => 2,
      foreground: () => true,
      foregroundExitEpoch: noForegroundExit,
      newestCommittedMessageId: messageId,
      onMarkRead: markRead,
      visible: () => true,
    });
    return undefined;
  });

  vi.advanceTimersByTime(500);
  expect(markRead).toHaveBeenLastCalledWith(2, 8);
  setMessageId(9);
  expect(markRead).toHaveBeenLastCalledWith(2, 9);
  expect(markRead).toHaveBeenCalledTimes(2);
});

it("restarts a qualified dwell after a coalesced foreground exit", () => {
  const [foregroundExitEpoch, setForegroundExitEpoch] = createSignal(0);
  const [messageId, setMessageId] = createSignal(8);
  const markRead = vi.fn();

  render(() => {
    createReadDwell({
      atLiveEdge: () => true,
      bufferId: () => 2,
      foreground: () => true,
      foregroundExitEpoch,
      newestCommittedMessageId: messageId,
      onMarkRead: markRead,
      visible: () => true,
    });
    return undefined;
  });

  vi.advanceTimersByTime(500);
  expect(markRead).toHaveBeenLastCalledWith(2, 8);

  batch(() => {
    setForegroundExitEpoch((epoch) => epoch + 1);
    setMessageId(9);
  });

  expect(markRead).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(499);
  expect(markRead).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(markRead).toHaveBeenLastCalledWith(2, 9);
});

it("cancels the dwell when the conversation stops qualifying", () => {
  const [foreground, setForeground] = createSignal(true);
  const markRead = vi.fn();

  render(() => {
    createReadDwell({
      atLiveEdge: () => true,
      bufferId: () => 2,
      foreground,
      foregroundExitEpoch: noForegroundExit,
      newestCommittedMessageId: () => 8,
      onMarkRead: markRead,
      visible: () => true,
    });
    return undefined;
  });

  vi.advanceTimersByTime(300);
  setForeground(false);
  vi.advanceTimersByTime(500);
  expect(markRead).not.toHaveBeenCalled();
});

it("qualifies each visible pane independently", () => {
  const firstAtLiveEdge = createSignal(true);
  const secondAtLiveEdge = createSignal(false);
  const markRead = vi.fn();

  render(() => {
    createReadDwell({
      atLiveEdge: firstAtLiveEdge[0],
      bufferId: () => 2,
      foreground: () => true,
      foregroundExitEpoch: noForegroundExit,
      newestCommittedMessageId: () => 8,
      onMarkRead: markRead,
      visible: () => true,
    });
    createReadDwell({
      atLiveEdge: secondAtLiveEdge[0],
      bufferId: () => 3,
      foreground: () => true,
      foregroundExitEpoch: noForegroundExit,
      newestCommittedMessageId: () => 9,
      onMarkRead: markRead,
      visible: () => true,
    });
    return undefined;
  });

  vi.advanceTimersByTime(500);
  expect(markRead).toHaveBeenCalledTimes(1);
  expect(markRead).toHaveBeenCalledWith(2, 8);

  firstAtLiveEdge[1](false);
  secondAtLiveEdge[1](true);
  vi.advanceTimersByTime(500);
  expect(markRead).toHaveBeenCalledTimes(2);
  expect(markRead).toHaveBeenLastCalledWith(3, 9);
});

it("does not mark a pane that is not visible", () => {
  const markRead = vi.fn();

  render(() => {
    createReadDwell({
      atLiveEdge: () => true,
      bufferId: () => 2,
      foreground: () => true,
      foregroundExitEpoch: noForegroundExit,
      newestCommittedMessageId: () => 8,
      onMarkRead: markRead,
      visible: () => false,
    });
    return undefined;
  });

  vi.advanceTimersByTime(500);
  expect(markRead).not.toHaveBeenCalled();
});

it("does not mark a pane away from its live edge", () => {
  const markRead = vi.fn();

  render(() => {
    createReadDwell({
      atLiveEdge: () => false,
      bufferId: () => 2,
      foreground: () => true,
      foregroundExitEpoch: noForegroundExit,
      newestCommittedMessageId: () => 8,
      onMarkRead: markRead,
      visible: () => true,
    });
    return undefined;
  });

  vi.advanceTimersByTime(500);
  expect(markRead).not.toHaveBeenCalled();
});
