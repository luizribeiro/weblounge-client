import { describe, expect, it } from "vitest";
import { PushPendingClock } from "./push-pending-clock";

function manualClock(startMs: number) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("PushPendingClock", () => {
  it("counts from page start", () => {
    const time = manualClock(1_000);
    const clock = new PushPendingClock(time.now);

    time.advance(4_000);

    expect(clock.pendingForMs(1)).toBe(4_000);
  });

  it("restarts every network when push setup starts again", () => {
    const time = manualClock(1_000);
    const clock = new PushPendingClock(time.now);
    clock.routeRequested(1);
    time.advance(20_000);

    clock.restartSetup();
    time.advance(2_000);

    expect(clock.pendingForMs(1)).toBe(2_000);
    expect(clock.pendingForMs(2)).toBe(2_000);
  });

  it("restarts only the network whose route the engine asks for", () => {
    const time = manualClock(1_000);
    const clock = new PushPendingClock(time.now);
    time.advance(30_000);

    clock.routeRequested(1);
    time.advance(1_500);

    expect(clock.pendingForMs(1)).toBe(1_500);
    expect(clock.pendingForMs(2)).toBe(31_500);
  });
});
