import { describe, expect, it } from "vitest";
import type { MessageProjection } from "../../engine/generated/MessageProjection";
import { reactionTarget } from "./reaction-target";

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
});
