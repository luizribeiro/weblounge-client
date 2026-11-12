import { describe, expect, it, vi } from "vitest";
import {
  currentMessageDensity,
  estimateMessageHeight,
  messageSizeRevision,
} from "./message-size-estimate";

describe("estimateMessageHeight", () => {
  it("reserves more height for long text in a narrow viewport", () => {
    const message = {
      delivery: "received" as const,
      kind: "text" as const,
      text: "x".repeat(2_000),
    };

    expect(estimateMessageHeight(message, 402, "cozy")).toBeGreaterThan(2_000);
    expect(estimateMessageHeight(message, 402, "cozy")).toBeGreaterThan(
      estimateMessageHeight(message, 1_440, "cozy"),
    );
  });

  it("accounts for explicit lines and density", () => {
    const message = {
      delivery: "received" as const,
      kind: "action" as const,
      text: "one\ntwo\nthree",
    };

    expect(estimateMessageHeight(message, 402, "comfortable")).toBeGreaterThan(
      estimateMessageHeight(message, 402, "compact"),
    );
  });

  it("reserves space and invalidates the estimate when reactions change", () => {
    const base = {
      delivery: "received" as const,
      kind: "text" as const,
      text: "hello",
    };
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
    const message = {
      delivery: "received" as const,
      kind: "text" as const,
      text: "hello",
    };
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
    expect(
      estimateMessageHeight(
        message,
        390,
        "cozy",
        "mobile",
        true,
        "after-divider",
      ),
    ).toBe(groupStart - 16);
    expect(
      estimateMessageHeight(
        message,
        1_280,
        "cozy",
        "desktop",
        true,
        "after-divider",
      ),
    ).toBe(estimateMessageHeight(message, 1_280, "cozy") - 3);
  });

  it("uses the notice-line rhythm for IRC notice estimates", () => {
    const notice = {
      delivery: "received" as const,
      kind: { irc_notice: "user" as const },
      text: "maintenance soon",
    };

    expect(estimateMessageHeight(notice, 390, "cozy", "mobile")).toBe(32);
    expect(estimateMessageHeight(notice, 1_280, "cozy", "desktop")).toBe(26);
  });

  it("uses the system-line rhythm for notice estimates", () => {
    const notice = {
      delivery: "received" as const,
      kind: { notice: { type: "info" as const } },
      text: "server information",
    };

    expect(
      estimateMessageHeight(
        notice,
        390,
        "cozy",
        "mobile",
        true,
        "after-message",
      ),
    ).toBe(30);
    expect(
      estimateMessageHeight(notice, 390, "cozy", "mobile", true, "after-line"),
    ).toBe(22);
    expect(
      estimateMessageHeight(
        notice,
        390,
        "cozy",
        "mobile",
        true,
        "after-divider",
      ),
    ).toBe(18);
    expect(estimateMessageHeight(notice, 1_280, "cozy", "desktop")).toBe(24);
    expect(
      estimateMessageHeight(
        notice,
        1_280,
        "cozy",
        "desktop",
        true,
        "after-divider",
      ),
    ).toBe(21);
  });

  it("builds notice revisions without generic serialization", () => {
    const stringify = vi.spyOn(JSON, "stringify");

    messageSizeRevision({
      delivery: "received",
      kind: { notice: { type: "topic", setter: "alice", set_at: 42 } },
      text: "new topic",
    });

    expect(stringify).not.toHaveBeenCalled();
  });

  it("reserves width and invalidates the estimate for delivery labels", () => {
    const confirmed = {
      delivery: "confirmed" as const,
      kind: "text" as const,
      text: "a message near the wrapping boundary",
    };
    const sending = { ...confirmed, delivery: "optimistic" as const };

    expect(estimateMessageHeight(sending, 402, "cozy")).toBeGreaterThan(
      estimateMessageHeight(confirmed, 402, "cozy"),
    );
    expect(messageSizeRevision(sending)).not.toBe(
      messageSizeRevision(confirmed),
    );

    const confirmedAction = { ...confirmed, kind: "action" as const };
    const failedAction = {
      ...confirmedAction,
      delivery: "failed" as const,
    };
    expect(estimateMessageHeight(failedAction, 402, "cozy")).toBeGreaterThan(
      estimateMessageHeight(confirmedAction, 402, "cozy"),
    );
  });
});

it("uses cozy density when the root has no valid density", () => {
  const root = document.createElement("html");
  expect(currentMessageDensity(root)).toBe("cozy");
  root.dataset.messageDensity = "compact";
  expect(currentMessageDensity(root)).toBe("compact");
});
