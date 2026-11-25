import { describe, expect, it, vi } from "vitest";
import type { MessageProjection } from "../../engine/generated/MessageProjection";
import { bufferReply, replyTarget } from "./reply-target";

const parent: MessageProjection = {
  id: 9,
  author: "alice",
  text: "does the relay see plaintext?",
  kind: "text",
  bot: null,
  authorship: "other",
  nick_color_index: 4,
  highlighted: false,
  delivery: "received",
  local_send_id: null,
  server_ids: ["parent-9"],
  server_time_ms: 1_000,
  received_at_ms: 1_000,
};
const network = {
  id: 1,
  label: "Local",
  nickname: "weblounge",
  state: "online" as const,
  can_reply: true,
};

describe("bufferReply", () => {
  it("binds the buffer while its network can thread replies", () => {
    const start = vi.fn();
    bufferReply(3, network, start)?.(parent);

    expect(start).toHaveBeenCalledWith(3, parent);
  });

  it("is absent without the capability, a buffer or a handler", () => {
    const start = vi.fn();
    expect(bufferReply(3, { ...network, can_reply: false }, start)).toBe(
      undefined,
    );
    expect(bufferReply(3, undefined, start)).toBe(undefined);
    expect(bufferReply(undefined, network, start)).toBe(undefined);
    expect(bufferReply(3, network, undefined)).toBe(undefined);
  });
});

describe("replyTarget", () => {
  it("starts a reply to a row the server delivered", () => {
    const start = vi.fn();
    replyTarget(parent, start)?.();

    expect(start).toHaveBeenCalledWith(parent);
  });

  it.each([
    ["an inert row", { ...parent, inert: true }],
    ["a row without a msgid", { ...parent, server_ids: [] }],
    ["an unsent row", { ...parent, delivery: "optimistic" as const }],
    ["a failed send", { ...parent, delivery: "failed" as const }],
    [
      "a deleted row",
      { ...parent, text: "", kind: { redacted: { by: null } } },
    ],
  ])("offers nothing for %s", (_label, message: MessageProjection) => {
    expect(replyTarget(message, vi.fn())).toBe(undefined);
  });

  it("offers nothing without a handler", () => {
    expect(replyTarget(parent, undefined)).toBe(undefined);
  });
});
