import type { TimelineItem } from "./generated/TimelineItem";

export type TimelineGeometry = "suffix" | "prefix" | "in-place" | "mixed";

export interface TimelineChange {
  readonly reset: boolean;
  readonly upserted: readonly TimelineItem[];
  readonly removed: readonly number[];
}

export interface AppliedTimeline {
  readonly items: readonly TimelineItem[];
  readonly geometry: TimelineGeometry;
}

export function applyTimelineChange(
  current: readonly TimelineItem[],
  change: TimelineChange,
): AppliedTimeline {
  if (change.reset) return { items: change.upserted, geometry: "mixed" };

  const geometry = geometryClass(current, change);
  const removed = new Set(change.removed);
  const upserted = new Set(change.upserted.map((item) => item.id));
  const items = current.filter(
    (item) => !removed.has(item.id) && !upserted.has(item.id),
  );
  for (const item of change.upserted) {
    items.splice(insertionIndex(items, item), 0, item);
  }
  return { items, geometry };
}

function geometryClass(
  current: readonly TimelineItem[],
  change: TimelineChange,
): TimelineGeometry {
  if (change.removed.length > 0) return "mixed";
  const byId = new Map(current.map((item) => [item.id, item]));
  if (
    change.upserted.every((item) =>
      sameOrder(byId.get(item.id)?.order, item.order),
    )
  )
    return "in-place";
  if (change.upserted.some((item) => byId.has(item.id))) return "mixed";
  if (current.length === 0) return "suffix";
  const firstUpserted = change.upserted[0];
  const oldLast = current.at(-1);
  if (
    firstUpserted !== undefined &&
    oldLast !== undefined &&
    compareOrder(firstUpserted.order, oldLast.order) > 0
  )
    return "suffix";
  const lastUpserted = change.upserted.at(-1);
  const oldFirst = current[0];
  if (
    lastUpserted !== undefined &&
    oldFirst !== undefined &&
    compareOrder(lastUpserted.order, oldFirst.order) < 0
  )
    return "prefix";
  return "mixed";
}

function insertionIndex(
  items: readonly TimelineItem[],
  inserted: TimelineItem,
): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const known = items[middle];
    if (known !== undefined && compareOrder(known.order, inserted.order) < 0)
      low = middle + 1;
    else high = middle;
  }
  return low;
}

function sameOrder(
  left: TimelineItem["order"] | undefined,
  right: TimelineItem["order"],
): boolean {
  return left !== undefined && compareOrder(left, right) === 0;
}

function compareOrder(
  left: TimelineItem["order"],
  right: TimelineItem["order"],
): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}
