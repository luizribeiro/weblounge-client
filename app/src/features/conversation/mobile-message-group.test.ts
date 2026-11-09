import { describe, expect, it } from "vitest";
import type { MessageProjection } from "../../engine/protocol";
import { startsMobileMessageGroup } from "./mobile-message-group";

const minute = Date.UTC(2026, 10, 9, 0, 53);

function message(
  overrides: Partial<MessageProjection> = {},
): MessageProjection {
  return {
    id: 1,
    author: "alice",
    text: "hello",
    kind: "text",
    bot: false,
    authorship: "other",
    nick_color_index: 1,
    highlighted: false,
    delivery: "received",
    local_send_id: null,
    server_ids: [],
    server_time_ms: minute,
    received_at_ms: minute,
    ...overrides,
  };
}

describe("startsMobileMessageGroup", () => {
  it("continues only the same sender in the same minute", () => {
    const previous = message();

    expect(startsMobileMessageGroup(previous, message({ id: 2 }))).toBe(false);
    expect(
      startsMobileMessageGroup(previous, message({ id: 2, author: "bob" })),
    ).toBe(true);
    expect(
      startsMobileMessageGroup(
        message({ server_time_ms: minute + 59_999 }),
        message({ id: 2, server_time_ms: minute + 60_000 }),
      ),
    ).toBe(true);
  });

  it("keeps distinct projected identities in distinct groups", () => {
    const previous = message();

    expect(
      startsMobileMessageGroup(previous, message({ id: 2, authorship: "own" })),
    ).toBe(true);
    expect(
      startsMobileMessageGroup(
        previous,
        message({ id: 2, unverified_sender: true }),
      ),
    ).toBe(true);
  });

  it("groups pending own messages by their receipt minute", () => {
    const previous = message({
      author: "weblounge",
      authorship: "own",
      delivery: "optimistic",
      server_time_ms: null,
    });
    const current = message({
      id: 2,
      author: "weblounge",
      authorship: "own",
      delivery: "optimistic",
      server_time_ms: null,
      received_at_ms: minute + 1,
    });

    expect(startsMobileMessageGroup(previous, current)).toBe(false);
  });

  it("starts after a divider and around non-message rows", () => {
    expect(startsMobileMessageGroup(undefined, message())).toBe(true);
    expect(
      startsMobileMessageGroup(message({ kind: "action" }), message({ id: 2 })),
    ).toBe(true);
    expect(
      startsMobileMessageGroup(message(), message({ id: 2, kind: "action" })),
    ).toBe(true);
  });
});
