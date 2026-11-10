import { describe, expect, it } from "vitest";
import {
  currentMessageDensity,
  estimateMessageHeight,
  messageSizeRevision,
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

  it("reserves space and invalidates the estimate when reactions change", () => {
    const base = { kind: "text" as const, text: "hello" };
    const reacted = {
      ...base,
      reactions: [
        {
          text: "👍",
          mine: false,
          actors: [{ nick: "alice", mine: false }],
        },
      ],
    };

    expect(estimateMessageHeight(reacted, 402, "cozy")).toBeGreaterThan(
      estimateMessageHeight(base, 402, "cozy"),
    );
    expect(messageSizeRevision(reacted)).not.toBe(messageSizeRevision(base));
  });

  it("estimates phone headers and continuation rows separately", () => {
    const message = { kind: "text" as const, text: "hello" };
    const groupStart = estimateMessageHeight(
      message,
      390,
      "cozy",
      "mobile",
      true,
    );
    const continuation = estimateMessageHeight(
      message,
      390,
      "cozy",
      "mobile",
      false,
    );

    expect(groupStart).toBeGreaterThan(continuation + 20);
    expect(messageSizeRevision(message, true)).not.toBe(
      messageSizeRevision(message, false),
    );
  });

  it("gives IRC notices the full sender-row estimate", () => {
    const text = { kind: "text" as const, text: "maintenance soon" };
    const notice = { kind: "irc_notice" as const, text: text.text };

    expect(estimateMessageHeight(notice, 390, "cozy", "mobile")).toBe(
      estimateMessageHeight(text, 390, "cozy", "mobile"),
    );
    expect(estimateMessageHeight(notice, 1_280, "cozy", "desktop")).toBe(
      estimateMessageHeight(text, 1_280, "cozy", "desktop"),
    );
  });

  it("uses the system-line rhythm for notice estimates", () => {
    const notice = {
      kind: { notice: { type: "info" as const } },
      text: "server information",
    };

    expect(estimateMessageHeight(notice, 390, "cozy", "mobile")).toBe(24);
    expect(estimateMessageHeight(notice, 1_280, "cozy", "desktop")).toBe(24);
  });
});

it("uses cozy density when the root has no valid density", () => {
  const root = document.createElement("html");
  expect(currentMessageDensity(root)).toBe("cozy");
  root.dataset.messageDensity = "compact";
  expect(currentMessageDensity(root)).toBe("compact");
});
