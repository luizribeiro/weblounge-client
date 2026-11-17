import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ClosedConversation, createCloseUndo } from "./close-undo";

const ana: ClosedConversation = { networkId: 1, title: "ana" };
const mel: ClosedConversation = { networkId: 1, title: "mel" };

function mount() {
  const reopened: ClosedConversation[] = [];
  return createRoot((dispose) => ({
    dispose,
    reopened,
    undo: createCloseUndo((conversation) => reopened.push(conversation)),
  }));
}

describe("createCloseUndo", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reopens the recorded conversation once", () => {
    const { undo, reopened, dispose } = mount();
    undo.record(ana);

    undo.undo();
    undo.undo();

    expect(reopened).toEqual([ana]);
    expect(undo.closed()).toBeUndefined();
    dispose();
  });

  it("offers only the latest close and restarts its window", () => {
    const { undo, reopened, dispose } = mount();
    undo.record(ana);
    vi.advanceTimersByTime(5_000);
    undo.record(mel);
    vi.advanceTimersByTime(5_000);

    expect(undo.closed()).toEqual(mel);
    undo.undo();
    expect(reopened).toEqual([mel]);
    dispose();
  });

  it("expires after six seconds", () => {
    const { undo, reopened, dispose } = mount();
    undo.record(ana);
    vi.advanceTimersByTime(6_000);

    expect(undo.closed()).toBeUndefined();
    undo.undo();
    expect(reopened).toEqual([]);
    dispose();
  });

  it("stops its timer when the owner is disposed", () => {
    const { undo, dispose } = mount();
    undo.record(ana);
    dispose();

    expect(vi.getTimerCount()).toBe(0);
  });
});
