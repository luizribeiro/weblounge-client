import { describe, expect, it } from "vitest";
import type { MessageProjection } from "../../engine/generated/MessageProjection";
import type { NetworkProjection } from "../../engine/generated/NetworkProjection";
import { bufferReactionToggle, reactionTarget } from "./reaction-target";

const message: MessageProjection = {
  id: 7,
  author: "alice",
  text: "ship it",
  kind: "text",
  bot: false,
  authorship: "other",
  nick_color_index: 2,
  highlighted: false,
  delivery: "received",
  local_send_id: null,
  server_ids: ["msg-7"],
  server_time_ms: 1_000,
  received_at_ms: 1_000,
};

describe("reactionTarget", () => {
  it("offers no reactions on a deleted message", () => {
    const redacted: MessageProjection = {
      ...message,
      text: "",
      kind: { redacted: { by: null } },
    };

    expect(reactionTarget(redacted, () => undefined)).toBeUndefined();
  });

  it("toggles reactions on a server message by its timeline id", () => {
    const toggled: [number, string][] = [];

    reactionTarget(message, (id, reaction) => toggled.push([id, reaction]))?.(
      "👍",
    );

    expect(toggled).toEqual([[7, "👍"]]);
  });

  it("offers no toggle without the capability", () => {
    expect(reactionTarget(message, undefined)).toBeUndefined();
  });

  it("offers no toggle on rows the server has not confirmed", () => {
    const toggle = () => undefined;
    for (const delivery of ["optimistic", "failed"] as const)
      expect(reactionTarget({ ...message, delivery }, toggle)).toBeUndefined();
    expect(
      reactionTarget({ ...message, server_ids: [] }, toggle),
    ).toBeUndefined();
  });

  it("offers no toggle on a row papo cannot address until the server repeats it", () => {
    expect(
      reactionTarget({ ...message, inert: true }, () => undefined),
    ).toBeUndefined();
  });
});

describe("bufferReactionToggle", () => {
  const network = { can_react: true } as NetworkProjection;

  it("addresses the buffer's messages while its network can react", () => {
    const toggled: [number, number, string][] = [];

    bufferReactionToggle(3, network, (buffer, id, reaction) =>
      toggled.push([buffer, id, reaction]),
    )?.(7, "🎉");

    expect(toggled).toEqual([[3, 7, "🎉"]]);
  });

  it("offers no toggle without a buffer, a sender or the capability", () => {
    const toggle = () => undefined;
    expect(bufferReactionToggle(undefined, network, toggle)).toBeUndefined();
    expect(bufferReactionToggle(3, network, undefined)).toBeUndefined();
    expect(bufferReactionToggle(3, undefined, toggle)).toBeUndefined();
    expect(
      bufferReactionToggle(3, { ...network, can_react: false }, toggle),
    ).toBeUndefined();
  });
});
