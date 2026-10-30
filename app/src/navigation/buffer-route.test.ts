import { describe, expect, it } from "vitest";
import type { BufferProjection, NetworkProjection } from "../engine/protocol";
import { bufferPath, parseBufferRoute } from "./buffer-route";

const network: NetworkProjection = {
  id: 1,
  label: "web lounge",
  nickname: "luiz",
  state: "online",
};

describe("buffer routes", () => {
  it.each([
    ["server", "web lounge", "/web%20lounge"],
    ["channel", "#lounge", "/web%20lounge/lounge"],
    ["channel", "##ops", "/web%20lounge/%23ops"],
    ["channel", "&local", "/web%20lounge/%26local"],
    ["direct", "mel", "/web%20lounge/@mel"],
  ] as const)("encodes a %s destination", (kind, title, expected) => {
    expect(bufferPath(network, buffer(kind, title))).toBe(expected);
  });

  it.each([
    ["/weblounge", { kind: "server", network: "weblounge" }],
    [
      "/weblounge/lounge",
      { kind: "channel", network: "weblounge", name: "#lounge" },
    ],
    [
      "/weblounge/%23ops",
      { kind: "channel", network: "weblounge", name: "##ops" },
    ],
    [
      "/weblounge/%26local",
      { kind: "channel", network: "weblounge", name: "&local" },
    ],
    ["/weblounge/@mel", { kind: "direct", network: "weblounge", name: "mel" }],
  ])("parses %s", (path, expected) => {
    expect(parseBufferRoute(path)).toEqual(expected);
  });

  it.each(["/", "/weblounge/", "/weblounge/a/b", "/%GG", "/w/@"])(
    "rejects the invalid route %s",
    (path) => expect(parseBufferRoute(path)).toBeUndefined(),
  );
});

function buffer(
  kind: BufferProjection["kind"],
  title: string,
): BufferProjection {
  return {
    id: 2,
    network_id: network.id,
    kind,
    title,
    draft_key: `test:${title}`,
    topic: null,
    unread: 0,
    mentions: 0,
    read_through: null,
  };
}
