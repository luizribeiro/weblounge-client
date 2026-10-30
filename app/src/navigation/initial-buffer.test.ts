import { expect, it } from "vitest";
import type { BufferProjection, NetworkProjection } from "../engine/protocol";
import {
  initialDestination,
  readLastViewedPath,
  writeLastViewedPath,
} from "./initial-buffer";

const networks: NetworkProjection[] = [
  { id: 1, label: "weblounge", nickname: "luiz", state: "online" },
];
const buffers: BufferProjection[] = [
  buffer(1, "server", "weblounge"),
  buffer(2, "channel", "#first"),
  buffer(3, "channel", "#second"),
  buffer(4, "direct", "mel"),
];
const loaded = new Set([1]);

it("prioritizes the URL over device-local history", () => {
  expect(
    initialDestination(
      "/weblounge/second",
      "/weblounge/first",
      networks,
      buffers,
      loaded,
    ),
  ).toEqual({ kind: "buffer", bufferId: 3, path: "/weblounge/second" });
});

it("restores the device-local buffer before falling back", () => {
  expect(
    initialDestination("/", "/weblounge/@mel", networks, buffers, loaded),
  ).toEqual({ kind: "buffer", bufferId: 4, path: "/weblounge/@mel" });
  expect(initialDestination("/", undefined, networks, buffers, loaded)).toEqual(
    {
      kind: "buffer",
      bufferId: 2,
      path: "/weblounge/first",
    },
  );
});

it("does not finalize a provisional server fallback", () => {
  expect(
    initialDestination("/", undefined, networks, buffers.slice(0, 1), loaded),
  ).toBeUndefined();
});

it("waits for the target network snapshot", () => {
  expect(
    initialDestination(
      "/weblounge/second",
      undefined,
      networks,
      buffers,
      new Set(),
    ),
  ).toBeUndefined();
});

it("keeps an unknown routed channel pending until its buffer arrives", () => {
  expect(
    initialDestination("/weblounge/new", undefined, networks, buffers, loaded),
  ).toBeUndefined();
  const joined = [...buffers, buffer(5, "channel", "#new")];
  expect(
    initialDestination("/weblounge/new", undefined, networks, joined, loaded),
  ).toEqual({ kind: "buffer", bufferId: 5, path: "/weblounge/new" });
});

it("stores only syntactically valid buffer paths", () => {
  writeLastViewedPath("/weblounge/first");
  expect(readLastViewedPath()).toBe("/weblounge/first");
  writeLastViewedPath("https://attacker.test/weblounge/second");
  expect(readLastViewedPath()).toBe("/weblounge/first");
});

function buffer(
  id: number,
  kind: BufferProjection["kind"],
  title: string,
): BufferProjection {
  return {
    id,
    network_id: 1,
    kind,
    title,
    draft_key: `10:weblounge:rfc1459:${title.toLowerCase()}`,
    topic: null,
    unread: 0,
    mentions: 0,
    read_through: null,
  };
}
