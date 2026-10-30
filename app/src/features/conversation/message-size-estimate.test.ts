import { describe, expect, it } from "vitest";
import {
  currentMessageDensity,
  estimateMessageHeight,
} from "./message-size-estimate";

describe("estimateMessageHeight", () => {
  it("reserves more height for long text in a narrow viewport", () => {
    const message = { kind: "text" as const, text: "x".repeat(2_000) };

    expect(estimateMessageHeight(message, 402, "cozy")).toBeGreaterThan(2_000);
    expect(estimateMessageHeight(message, 402, "cozy")).toBeGreaterThan(
      estimateMessageHeight(message, 1_440, "cozy"),
    );
  });

  it("accounts for explicit lines and density", () => {
    const message = { kind: "action" as const, text: "one\ntwo\nthree" };

    expect(estimateMessageHeight(message, 402, "comfortable")).toBeGreaterThan(
      estimateMessageHeight(message, 402, "compact"),
    );
  });
});

it("uses cozy density when the root has no valid density", () => {
  const root = document.createElement("html");
  expect(currentMessageDensity(root)).toBe("cozy");
  root.dataset.messageDensity = "compact";
  expect(currentMessageDensity(root)).toBe("compact");
});
