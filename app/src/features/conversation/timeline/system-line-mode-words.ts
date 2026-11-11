import type { Actor } from "../../../engine/generated/Actor";
import type { ModeProjection } from "../../../engine/generated/ModeProjection";
import {
  actorWords,
  mono,
  naturalList,
  nick,
  text,
} from "./system-line-segments";
import type {
  SystemLineSegment,
  SystemLineWordOptions,
} from "./system-line-word-types";

export function modeWords(
  actor: Actor,
  changes: readonly ModeProjection[],
  options: SystemLineWordOptions,
): SystemLineSegment[] {
  let priorRankVerb: "gave" | "took" | undefined;
  const descriptions = changes.map((change) => {
    const meaning = change.meaning;
    if (meaning.type === "rank") {
      const verb = change.added ? "gave" : "took";
      const lead = priorRankVerb === verb ? "" : `${verb} `;
      priorRankVerb = verb;
      return [
        text(
          `${lead}${rankName(meaning.rank.mode)} ${change.added ? "to" : "from"} `,
        ),
        nick(meaning.member),
      ];
    }
    priorRankVerb = undefined;
    switch (meaning.type) {
      case "ban":
        return [
          text(change.added ? "banned " : "lifted the ban on "),
          mono(meaning.mask),
        ];
      case "ban_exception":
        return [
          text(
            change.added
              ? "added a ban exception for "
              : "removed the ban exception for ",
          ),
          mono(meaning.mask),
        ];
      case "invite_exception":
        return [
          text(
            change.added
              ? "added an invite exception for "
              : "removed the invite exception for ",
          ),
          mono(meaning.mask),
        ];
      case "quiet":
        return [
          text(change.added ? "quieted " : "unquieted "),
          mono(meaning.mask),
        ];
      case "moderated":
        return [
          text(
            change.added
              ? "made the channel moderated"
              : "made the channel unmoderated",
          ),
        ];
      case "topic_locked":
        return [text(change.added ? "locked the topic" : "unlocked the topic")];
      case "no_external":
        return [
          text(
            change.added
              ? "blocked outside messages"
              : "allowed outside messages",
          ),
        ];
      case "invite_only":
        return [
          text(
            change.added
              ? "made the channel invite-only"
              : "opened the channel to everyone",
          ),
        ];
      case "secret":
        return [
          text(
            change.added
              ? "made the channel secret"
              : "made the channel public",
          ),
        ];
      case "private":
        return [
          text(
            change.added
              ? "made the channel private"
              : "made the channel public",
          ),
        ];
      case "key":
        return [text(change.added ? "set a key" : "removed the key")];
      case "limit":
        return [
          text(
            change.added && meaning.limit !== null
              ? `set a ${meaning.limit}-person limit`
              : change.added
                ? "set a person limit"
                : "removed the person limit",
          ),
        ];
      case "other":
        return [text("set mode "), mono(safeRawMode(change))];
      default: {
        const exhaustive: never = meaning;
        return exhaustive;
      }
    }
  });
  const words = [...actorWords(actor), text(" "), ...naturalList(descriptions)];
  if (options.includeRawModes !== true || changes.length === 0) return words;
  const raw = compactRawModes(changes);
  return raw === "" ? words : [...words, mono(`   ${raw}`)];
}

function safeRawMode(change: ModeProjection): string {
  if (change.meaning.type !== "key") return change.raw;
  const [mode, parameter] = change.raw.trim().split(/\s+/u);
  return mode === undefined ? "" : parameter === undefined ? mode : `${mode} *`;
}

function compactRawModes(changes: readonly ModeProjection[]): string {
  const groups: string[] = [];
  let modes = "";
  let parameters: string[] = [];
  let added: boolean | undefined;
  const flush = () => {
    if (modes !== "") groups.push([modes, ...parameters].join(" "));
    modes = "";
    parameters = [];
    added = undefined;
  };
  for (const change of changes) {
    if (change.raw_group_start) flush();
    const [token, ...rawParameters] = safeRawMode(change).trim().split(/\s+/u);
    const mode = token?.replace(/^[+-]/u, "");
    if (mode === undefined || mode === "") continue;
    if (added !== change.added) {
      modes += change.added ? "+" : "-";
      added = change.added;
    }
    modes += mode;
    parameters.push(...rawParameters);
  }
  flush();
  return groups.join(" ");
}

function rankName(mode: string): string {
  return (
    { a: "admin", h: "half-op", o: "op", q: "owner", v: "voice" }[
      mode.toLowerCase()
    ] ?? `mode ${mode}`
  );
}
