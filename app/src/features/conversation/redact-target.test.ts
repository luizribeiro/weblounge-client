import { describe, expect, it } from "vitest";
import type { MessageProjection } from "../../engine/generated/MessageProjection";
import { bufferRedaction, canRedact } from "./redact-target";

const own: MessageProjection = {
  id: 9,
  author: "weblounge",
  text: "take this back",
  kind: "text",
  bot: null,
  authorship: "own",
  nick_color_index: 0,
  highlighted: false,
  delivery: "confirmed",
  local_send_id: null,
  server_ids: ["mine-9"],
  server_time_ms: 1_000,
  received_at_ms: 1_000,
};
const redact = () => undefined;

describe("canRedact", () => {
  it("allows an own confirmed message, again after a failure", () => {
    expect(canRedact(own, redact)).toBe(true);
    expect(canRedact({ ...own, own_redaction: "failed" }, redact)).toBe(true);
  });

  it("refuses without the capability and for other rows", () => {
    expect(canRedact(own, undefined)).toBe(false);
    for (const message of [
      { ...own, authorship: "other" as const },
      { ...own, delivery: "optimistic" as const, server_ids: [] },
      { ...own, own_redaction: "sending" as const },
      { ...own, inert: true },
      { ...own, text: "", kind: { redacted: { by: null } } },
    ])
      expect(canRedact(message, redact)).toBe(false);
  });
});

describe("bufferRedaction", () => {
  const network = {
    id: 1,
    label: "Local",
    nickname: "weblounge",
    state: "online" as const,
    can_redact: true,
  };

  it("binds the buffer while its network can delete messages", () => {
    const deleted: [number, number][] = [];
    bufferRedaction(4, network, (buffer, message) =>
      deleted.push([buffer, message]),
    )?.(9);

    expect(deleted).toEqual([[4, 9]]);
    expect(
      bufferRedaction(4, { ...network, can_redact: false }, () => undefined),
    ).toBeUndefined();
    expect(
      bufferRedaction(undefined, network, () => undefined),
    ).toBeUndefined();
  });
});
