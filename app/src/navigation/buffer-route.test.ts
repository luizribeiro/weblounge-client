import { describe, expect, it } from "vitest";
import type { BufferProjection, NetworkProjection } from "../engine/protocol";
import {
  bufferPath,
  parseBufferRoute,
  resolveBufferRoute,
} from "./buffer-route";

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

  it("resolves names with the buffer's IRC casemapping", () => {
    const route = parseBufferRoute("/web%20lounge/ROOM%5B");
    const room = {
      ...buffer("channel", "#room{"),
      draft_key: "10:web lounge:rfc1459:#room{",
    };

    expect(
      route === undefined
        ? undefined
        : resolveBufferRoute(route, [network], [room]),
    ).toEqual({ kind: "buffer", bufferId: room.id });
  });

  it("keeps an unknown channel inert until Join is chosen", () => {
    const route = parseBufferRoute("/web%20lounge/new-room");

    expect(
      route === undefined
        ? undefined
        : resolveBufferRoute(route, [network], []),
    ).toEqual({ kind: "not_joined", networkId: 1, channel: "#new-room" });
  });
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
