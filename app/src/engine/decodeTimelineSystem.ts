import {
  decodeArray,
  decodeString,
  isNullableString,
  isOneOf,
  isRecord,
} from "./decode-primitives";
import {
  decodeActor,
  decodeDeparture,
  decodeMode,
  decodeNickChange,
  decodePerson,
  decodeSubject,
} from "./decodeTimelinePeople";
import { ENGINE_MESSAGE_KEYS } from "./generated/EngineMessageKeys";
import type { LineEvent } from "./generated/LineEvent";
import type { RunClauses } from "./generated/RunClauses";
import type { SystemLine } from "./generated/SystemLine";

export function decodeSystemLine(value: unknown): SystemLine | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "run") {
    const clauses = decodeArray(value.clauses, decodeRunClause);
    if (clauses !== undefined && clauses.length > 0)
      return { type: "run", clauses };
  }
  if (value.type === "event") {
    const event = decodeLineEvent(value.event);
    if (event !== undefined) return { type: "event", event };
  }
  return undefined;
}

function decodeRunClause(value: unknown): RunClauses[number] | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (
    isOneOf(value.type, [
      "joined",
      "joined_and_left",
      "reconnected",
      "rejoined",
    ])
  ) {
    const people = decodeArray(value.people, decodePerson);
    return people === undefined ? undefined : { type: value.type, people };
  }
  if (isOneOf(value.type, ["left", "quit"])) {
    const people = decodeArray(value.people, decodeDeparture);
    return people === undefined ? undefined : { type: value.type, people };
  }
  if (value.type === "nick") {
    const changes = decodeArray(value.changes, decodeNickChange);
    return changes === undefined ? undefined : { type: "nick", changes };
  }
  if (value.type === "modes") {
    const actor = decodeActor(value.actor);
    const changes = decodeArray(value.changes, decodeMode);
    if (actor !== undefined && changes !== undefined)
      return { type: "modes", actor, changes };
  }
  if (value.type === "invited") {
    const actor = decodeActor(value.actor);
    const people = decodeArray(value.people, decodePerson);
    if (actor !== undefined && people !== undefined)
      return { type: "invited", actor, people };
  }
  return undefined;
}

function decodeLineEvent(value: unknown): LineEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  const actor = decodeActor(value.actor);
  if (value.type === "kick") {
    const subject = decodeSubject(value.subject);
    if (
      actor !== undefined &&
      subject !== undefined &&
      isNullableString(value.reason)
    )
      return { type: "kick", actor, subject, reason: value.reason };
  }
  if (
    value.type === "topic" &&
    actor !== undefined &&
    isNullableString(value.topic)
  )
    return { type: "topic", actor, topic: value.topic };
  if (
    value.type === "topic_card" &&
    typeof value.topic === "string" &&
    isNullableString(value.setter) &&
    isNullableNumber(value.set_at_ms)
  )
    return {
      type: "topic_card",
      topic: value.topic,
      setter: value.setter,
      set_at_ms: value.set_at_ms,
    };
  if (
    value.type === "invited_you" &&
    actor !== undefined &&
    typeof value.channel === "string"
  )
    return { type: "invited_you", actor, channel: value.channel };
  if (
    value.type === "renamed" &&
    actor !== undefined &&
    typeof value.old === "string" &&
    typeof value.new === "string"
  )
    return { type: "renamed", old: value.old, new: value.new, actor };
  if (
    value.type === "connected" &&
    typeof value.server === "string" &&
    typeof value.secure === "boolean"
  )
    return { type: "connected", server: value.server, secure: value.secure };
  if (value.type === "motd") {
    const lines = decodeArray(value.lines, decodeString);
    if (lines !== undefined) return { type: "motd", lines };
  }
  if (
    value.type === "reply" &&
    typeof value.code === "string" &&
    typeof value.text === "string" &&
    isOneOf(value.severity, ["fail", "warn", "note"])
  )
    return {
      type: "reply",
      code: value.code,
      text: value.text,
      severity: value.severity,
    };
  if (value.type === "raw" && typeof value.line === "string")
    return { type: "raw", line: value.line };
  if (
    value.type === "note" &&
    isOneOf(value.key, ENGINE_MESSAGE_KEYS) &&
    isStringRecord(value.values) &&
    isOneOf(value.tone, ["neutral", "error"])
  )
    return {
      type: "note",
      key: value.key,
      values: value.values,
      tone: value.tone,
    };
  return undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}
