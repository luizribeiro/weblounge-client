import { describe, expect, it } from "vitest";
import {
  clampZoom,
  maxZoom,
  secondaryZoom,
  steppedZoom,
  tokenMilliseconds,
} from "./viewer-zoom";

describe("secondaryZoom", () => {
  it("shows actual pixels for a screenshot that fits at a third of its size", () => {
    expect(secondaryZoom(1 / 3)).toBe(1);
  });

  it("doubles the fit when actual pixels would barely enlarge it", () => {
    expect(secondaryZoom(0.8)).toBe(1.6);
  });

  it("doubles a small image that already shows at natural size", () => {
    expect(secondaryZoom(1)).toBe(2);
  });
});

describe("maxZoom", () => {
  it("allows four times natural size", () => {
    expect(maxZoom(0.25)).toBe(4);
    expect(maxZoom(1)).toBe(4);
  });

  it("never falls below the secondary level", () => {
    expect(maxZoom(3)).toBe(6);
  });
});

describe("steppedZoom", () => {
  const range = { fit: 0.4, max: 4 };

  it("steps by one and a half times in each direction", () => {
    expect(steppedZoom(1, "in", range)).toBe(1.5);
    expect(steppedZoom(1.5, "out", range)).toBe(1);
  });

  it("clamps to the fit and the maximum", () => {
    expect(steppedZoom(0.5, "out", range)).toBe(0.4);
    expect(steppedZoom(3, "in", range)).toBe(4);
  });
});

describe("clampZoom", () => {
  const range = { fit: 0.5, max: 4 };

  it("keeps a level inside the range", () => {
    expect(clampZoom(1.5, range)).toBe(1.5);
  });

  it("clamps a pinch beyond either limit", () => {
    expect(clampZoom(0.1, range)).toBe(0.5);
    expect(clampZoom(10, range)).toBe(4);
  });
});

describe("tokenMilliseconds", () => {
  it("reads millisecond and second motion tokens", () => {
    expect(tokenMilliseconds(" 280ms")).toBe(280);
    expect(tokenMilliseconds("0.2s")).toBe(200);
  });

  it("treats reduced motion and missing tokens as instant", () => {
    expect(tokenMilliseconds("0ms")).toBe(0);
    expect(tokenMilliseconds("")).toBe(0);
    expect(tokenMilliseconds("280")).toBe(0);
  });
});
