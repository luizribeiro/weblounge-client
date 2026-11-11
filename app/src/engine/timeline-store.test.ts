import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeArray, decodeNumber, isRecord } from "./decode-primitives";
import { decodeTimelineItem } from "./decodeTimelineItem";
import type { TimelineItem } from "./generated/TimelineItem";
import {
  applyTimelineChange,
  deriveJumpCount,
  type TimelineChange,
  type TimelineGeometry,
  TimelineStore,
} from "./timeline-store";

it("matches the Rust reducer on every shared fixture", () => {
  const fixtures = decodeFixtures(
    JSON.parse(readFileSync("../fixtures/timeline/reducer.json", "utf8")),
  );
  expect(fixtures.version).toBe(1);
  expect(fixtures.cases).toHaveLength(9);

  for (const fixture of fixtures.cases) {
    expect(applyTimelineChange(fixture.initial, fixture.change)).toEqual({
      items: fixture.expected_items,
      geometry: fixture.geometry,
    });
  }
});

it("applies reset and removed identities", () => {
  expect(
    applyTimelineChange([gap(1, 10), gap(2, 20)], {
      reset: true,
      upserted: [gap(3, 30)],
      removed: [],
    }),
  ).toEqual({ items: [gap(3, 30)], geometry: "mixed" });
  expect(
    applyTimelineChange([gap(1, 10), gap(2, 20)], {
      reset: false,
      upserted: [],
      removed: [1],
    }),
  ).toEqual({ items: [gap(2, 20)], geometry: "mixed" });
});

it("keeps buffer timelines independent and removes closed buffers", () => {
  const store = new TimelineStore();
  store.apply(1, change([gap(1, 10)]));
  store.apply(2, change([gap(2, 20)]));

  expect(store.get(1)?.items).toEqual([gap(1, 10)]);
  expect(store.get(2)?.items).toEqual([gap(2, 20)]);
  store.remove(1);
  expect(store.get(1)).toBeUndefined();
});

it("retains full focus history and bounds every unfocused family", () => {
  const store = new TimelineStore();
  const items = Array.from({ length: 501 }, (_, index) => [
    message(index * 2 + 1, index * 2 + 1),
    gap(index * 2 + 2, index * 2 + 2),
  ]).flat();
  store.focus(1);
  store.apply(1, { reset: true, upserted: items, removed: [] });
  store.apply(2, { reset: true, upserted: items, removed: [] });

  expect(store.get(1)?.items).toHaveLength(1_002);
  expect(store.get(2)?.items).toHaveLength(1_000);
  expect(store.get(2)?.items.map((item) => item.id)).not.toContain(1);
  expect(store.get(2)?.items.map((item) => item.id)).not.toContain(2);

  store.focus(2);
  expect(store.get(1)?.items).toHaveLength(1_000);
  expect(store.get(2)?.items).toHaveLength(1_000);
});

it("counts only newly appended peer message rows while away", () => {
  let count = 2;
  count = deriveJumpCount(count, false, change([message(1, 10)]), "prefix");
  expect(count).toBe(2);

  const ownSend = change([{ ...message(3, 30), body: ownBody(3, 30) }]);
  count = deriveJumpCount(count, false, ownSend, "suffix");
  expect(count).toBe(2);

  const catchUp = change([
    message(4, 40),
    { ...message(5, 50), body: ownBody(5, 50) },
    message(6, 60),
  ]);
  count = deriveJumpCount(count, false, catchUp, "suffix");
  expect(count).toBe(4);
  expect(deriveJumpCount(count, true, catchUp, "suffix")).toBe(0);
});

interface FixtureFile {
  readonly version: number;
  readonly cases: readonly FixtureCase[];
}

interface FixtureCase {
  readonly initial: readonly TimelineItem[];
  readonly change: TimelineChange;
  readonly expected_items: readonly TimelineItem[];
  readonly geometry: TimelineGeometry;
}

function decodeFixtures(value: unknown): FixtureFile {
  if (!isRecord(value) || typeof value.version !== "number")
    throw new Error("invalid timeline reducer fixtures");
  const cases = decodeArray(value.cases, decodeCase);
  if (cases === undefined) throw new Error("invalid timeline reducer cases");
  return {
    version: value.version,
    cases,
  };
}

function decodeCase(value: unknown): FixtureCase | undefined {
  if (!isRecord(value) || !isGeometry(value.geometry)) return undefined;
  const initial = decodeArray(value.initial, decodeTimelineItem);
  const upserted = isRecord(value.change)
    ? decodeArray(value.change.upserted, decodeTimelineItem)
    : undefined;
  const removed = isRecord(value.change)
    ? decodeArray(value.change.removed, decodeNumber)
    : undefined;
  const expected = decodeArray(value.expected_items, decodeTimelineItem);
  if (
    initial === undefined ||
    upserted === undefined ||
    removed === undefined ||
    expected === undefined ||
    !isRecord(value.change) ||
    typeof value.change.reset !== "boolean"
  )
    return undefined;
  return {
    initial,
    change: { reset: value.change.reset, upserted, removed },
    expected_items: expected,
    geometry: value.geometry,
  };
}

function gap(id: number, time: number): TimelineItem {
  return {
    id,
    order: [time, time, id],
    day: 1,
    content_version: 0,
    body: { family: "gap", from_ms: time, to_ms: time + 1 },
  };
}

function message(id: number, time: number): TimelineItem {
  return {
    id,
    order: [time, time, id],
    day: 1,
    content_version: 0,
    body: {
      family: "message",
      id,
      author: "nick",
      text: "text",
      kind: "text",
      bot: false,
      authorship: "other",
      nick_color_index: 0,
      highlighted: false,
      delivery: "received",
      local_send_id: null,
      server_ids: [],
      server_time_ms: time,
      received_at_ms: time,
    },
  };
}

function change(upserted: readonly TimelineItem[]): TimelineChange {
  return { reset: false, upserted, removed: [] };
}

function ownBody(id: number, time: number) {
  const body = message(id, time).body;
  if (body.family !== "message") throw new Error("message fixture expected");
  return { ...body, authorship: "own" as const };
}

function isGeometry(value: unknown): value is TimelineGeometry {
  return ["suffix", "prefix", "in-place", "mixed"].some(
    (geometry) => geometry === value,
  );
}
