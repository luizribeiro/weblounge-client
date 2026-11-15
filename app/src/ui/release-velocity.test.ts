import { describe, expect, it } from "vitest";
import { recentPointerSamples, releaseVelocityX } from "./release-velocity";

describe("release velocity", () => {
  it("measures a release that lands on the last move's position", () => {
    const flick = [
      { time: 0, x: 300 },
      { time: 16, x: 288 },
      { time: 32, x: 272 },
      { time: 48, x: 255 },
    ];
    expect(releaseVelocityX(flick, 255, 56)).toBeCloseTo(-45 / 56);
  });

  it("ignores samples older than the release window", () => {
    const pausedThenFlicked = [
      { time: 0, x: 300 },
      { time: 400, x: 280 },
      { time: 450, x: 260 },
    ];
    expect(recentPointerSamples(pausedThenFlicked, 240, 500)).toEqual([
      { time: 400, x: 280 },
      { time: 450, x: 260 },
      { time: 500, x: 240 },
    ]);
    expect(releaseVelocityX(pausedThenFlicked, 240, 500)).toBeCloseTo(-0.4);
  });

  it("reads a held pointer as stationary", () => {
    expect(releaseVelocityX([{ time: 0, x: 280 }], 280, 300)).toBe(0);
    expect(releaseVelocityX([], 280, 300)).toBe(0);
  });
});
