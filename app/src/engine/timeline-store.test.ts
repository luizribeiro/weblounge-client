import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeArray, decodeNumber, isRecord } from "./decode-primitives";
import type { TimelineItem } from "./generated/TimelineItem";
import {
  applyTimelineChange,
  type TimelineChange,
  type TimelineGeometry,
} from "./timeline-store";

it("matches the Rust reducer on every shared fixture", () => {
  const fixtures = decodeFixtures(
    JSON.parse(readFileSync("../fixtures/timeline/reducer.json", "utf8")),
  );
  expect(fixtures.version).toBe(1);
  expect(fixtures.cases).toHaveLength(7);

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
  const initial = decodeArray(value.initial, decodeGapItem);
  const upserted = isRecord(value.change)
    ? decodeArray(value.change.upserted, decodeGapItem)
    : undefined;
  const removed = isRecord(value.change)
    ? decodeArray(value.change.removed, decodeNumber)
    : undefined;
  const expected = decodeArray(value.expected_items, decodeGapItem);
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

function decodeGapItem(value: unknown): TimelineItem | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !isOrder(value.order) ||
    typeof value.day !== "number" ||
    typeof value.content_version !== "number" ||
    !isRecord(value.body) ||
    value.body.family !== "gap" ||
    typeof value.body.from_ms !== "number" ||
    typeof value.body.to_ms !== "number"
  )
    return undefined;
  return {
    id: value.id,
    order: value.order,
    day: value.day,
    content_version: value.content_version,
    body: {
      family: "gap",
      from_ms: value.body.from_ms,
      to_ms: value.body.to_ms,
    },
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

function isOrder(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((part) => typeof part === "number")
  );
}

function isGeometry(value: unknown): value is TimelineGeometry {
  return ["suffix", "prefix", "in-place", "mixed"].some(
    (geometry) => geometry === value,
  );
}
