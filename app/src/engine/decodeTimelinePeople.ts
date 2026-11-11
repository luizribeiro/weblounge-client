import { isNullableString, isOneOf, isRecord } from "./decode-primitives";
import type { Actor } from "./generated/Actor";
import type { Departure } from "./generated/Departure";
import type { ModeMeaning } from "./generated/ModeMeaning";
import type { ModeProjection } from "./generated/ModeProjection";
import type { NickChange } from "./generated/NickChange";
import type { Person } from "./generated/Person";
import type { Subject } from "./generated/Subject";

export function decodePerson(value: unknown): Person | undefined {
  if (
    !isRecord(value) ||
    typeof value.nick !== "string" ||
    typeof value.nick_color_index !== "number" ||
    typeof value.me !== "boolean"
  )
    return undefined;
  return {
    nick: value.nick,
    nick_color_index: value.nick_color_index,
    me: value.me,
  };
}

export function decodeActor(value: unknown): Actor | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "server" && typeof value.name === "string")
    return { type: "server", name: value.name };
  const person = value.type === "user" ? decodePerson(value) : undefined;
  return person === undefined ? undefined : { type: "user", ...person };
}

export function decodeSubject(value: unknown): Subject | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "you") return { type: "you" };
  const person = value.type === "other" ? decodePerson(value) : undefined;
  return person === undefined ? undefined : { type: "other", ...person };
}

export function decodeDeparture(value: unknown): Departure | undefined {
  const person = isRecord(value) ? decodePerson(value.person) : undefined;
  if (
    person === undefined ||
    !isRecord(value) ||
    !isNullableString(value.reason)
  )
    return undefined;
  return { person, reason: value.reason };
}

export function decodeNickChange(value: unknown): NickChange | undefined {
  const old = isRecord(value) ? decodePerson(value.old) : undefined;
  const next = isRecord(value) ? decodePerson(value.new) : undefined;
  return old === undefined || next === undefined
    ? undefined
    : { old, new: next };
}

export function decodeMode(value: unknown): ModeProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.added !== "boolean" ||
    typeof value.raw !== "string" ||
    typeof value.raw_group_start !== "boolean"
  )
    return undefined;
  const meaning = decodeModeMeaning(value.meaning);
  return meaning === undefined
    ? undefined
    : {
        added: value.added,
        meaning,
        raw: value.raw,
        raw_group_start: value.raw_group_start,
      };
}

function decodeModeMeaning(value: unknown): ModeMeaning | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "rank") {
    const member = decodePerson(value.member);
    if (
      isRecord(value.rank) &&
      typeof value.rank.mode === "string" &&
      typeof value.rank.symbol === "string" &&
      member !== undefined
    )
      return {
        type: "rank",
        rank: { mode: value.rank.mode, symbol: value.rank.symbol },
        member,
      };
  }
  if (
    isOneOf(value.type, [
      "ban",
      "ban_exception",
      "invite_exception",
      "quiet",
    ]) &&
    typeof value.mask === "string"
  )
    return { type: value.type, mask: value.mask };
  if (
    isOneOf(value.type, [
      "moderated",
      "topic_locked",
      "no_external",
      "invite_only",
      "secret",
      "private",
      "key",
      "other",
    ])
  )
    return { type: value.type };
  if (value.type === "limit" && isNullableString(value.limit))
    return { type: "limit", limit: value.limit };
  return undefined;
}
