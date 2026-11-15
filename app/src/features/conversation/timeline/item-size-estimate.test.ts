import { describe, expect, it } from "vitest";
import type { SystemProjection } from "../../../engine/generated/SystemProjection";
import {
  estimateSystemLineHeight,
  systemLineSizeRevision,
} from "./item-size-estimate";

const system: SystemProjection = {
  time_ms: 1,
  line: {
    type: "run",
    clauses: [
      {
        type: "joined",
        people: ["kiwi", "zed", "ana", "tomo", "bob"].map((nick, index) => ({
          nick,
          nick_color_index: index,
          me: false,
        })),
      },
    ],
  },
};

describe("estimateSystemLineHeight", () => {
  it("accounts for wrapping and the signed phone spacing", () => {
    expect(
      estimateSystemLineHeight(
        system,
        240,
        "cozy",
        "mobile",
        false,
        false,
        "after-message",
      ),
    ).toBeGreaterThan(
      estimateSystemLineHeight(
        system,
        600,
        "cozy",
        "mobile",
        false,
        false,
        "after-message",
      ),
    );
    expect(
      estimateSystemLineHeight(
        system,
        600,
        "cozy",
        "mobile",
        false,
        false,
        "after-message",
      ) -
        estimateSystemLineHeight(
          system,
          600,
          "cozy",
          "mobile",
          false,
          false,
          "after-line",
        ),
    ).toBe(8);
  });

  it("reserves every expanded person line and detail gap", () => {
    expect(
      estimateSystemLineHeight(
        system,
        390,
        "cozy",
        "mobile",
        true,
        false,
        "after-line",
      ),
    ).toBeGreaterThan(
      estimateSystemLineHeight(
        system,
        390,
        "cozy",
        "mobile",
        false,
        false,
        "after-line",
      ),
    );
  });

  it("reserves the changed topic's own wrapped lines", () => {
    const topic = (value: string | null): SystemProjection => ({
      time_ms: 1,
      line: {
        type: "event",
        event: {
          type: "topic",
          actor: { type: "user", nick: "mel", nick_color_index: 1, me: false },
          topic: value,
        },
      },
    });
    const estimate = (projection: SystemProjection) =>
      estimateSystemLineHeight(
        projection,
        390,
        "cozy",
        "mobile",
        false,
        false,
        "after-message",
      );

    expect(estimate(topic("short"))).toBe(estimate(topic(null)) + 22);
    expect(estimate(topic("long topic ".repeat(20)))).toBeGreaterThan(
      estimate(topic("short")) + 20,
    );
  });

  it("invalidates on every geometry input", () => {
    expect(systemLineSizeRevision(7, 3, true, false, "message", "mobile")).toBe(
      "7:3:true:false:message:mobile",
    );
  });
});
