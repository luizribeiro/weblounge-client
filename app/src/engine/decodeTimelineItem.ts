import { isRecord } from "./decode-primitives";
import { decodeSystemLine } from "./decodeTimelineSystem";
import { decodeMessage } from "./EngineClient";
import type { ItemBody } from "./generated/ItemBody";
import type { TimelineItem } from "./generated/TimelineItem";

export function decodeTimelineItem(value: unknown): TimelineItem | undefined {
  const body = isRecord(value) ? decodeBody(value.body) : undefined;
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !isOrder(value.order) ||
    typeof value.day !== "number" ||
    typeof value.content_version !== "number" ||
    body === undefined
  )
    return undefined;
  return {
    id: value.id,
    order: value.order,
    day: value.day,
    content_version: value.content_version,
    body,
  };
}

function decodeBody(value: unknown): ItemBody | undefined {
  if (!isRecord(value)) return undefined;
  if (value.family === "message") {
    const message = decodeMessage(value);
    return message === undefined
      ? undefined
      : { family: "message", ...message };
  }
  if (
    value.family === "gap" &&
    typeof value.from_ms === "number" &&
    typeof value.to_ms === "number"
  )
    return { family: "gap", from_ms: value.from_ms, to_ms: value.to_ms };
  const line =
    value.family === "system" ? decodeSystemLine(value.line) : undefined;
  if (line !== undefined && typeof value.time_ms === "number")
    return { family: "system", time_ms: value.time_ms, line };
  return undefined;
}

function isOrder(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((part) => typeof part === "number")
  );
}
