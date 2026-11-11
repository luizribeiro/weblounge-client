import type { RunClauses } from "../../../engine/generated/RunClauses";
import { departureWords } from "./system-line-clause-words";
import { modeWords } from "./system-line-mode-words";
import {
  actorWords,
  button,
  joinSegments,
  nick,
  text,
} from "./system-line-segments";
import type {
  SystemLineIcon,
  SystemLineSegment,
  SystemLineWordOptions,
  SystemLineWords,
} from "./system-line-word-types";

export function expandedRunWords(
  clauses: RunClauses,
  options: SystemLineWordOptions,
  icon: SystemLineIcon,
): SystemLineWords {
  const summaries = clauses.map(clauseCountWords);
  const segments = [
    ...joinSegments(summaries, " · "),
    text(" · "),
    button("collapse", "Show less", "Show less"),
  ];
  const details = clauses.flatMap((clause) =>
    expandedClauseWords(clause, options),
  );
  return { details, icon, segments, warning: false };
}

function clauseCountWords(clause: RunClauses[number]): SystemLineSegment[] {
  switch (clause.type) {
    case "joined":
      return [text(countPhrase(clause.people.length, "joined"))];
    case "joined_and_left":
      return [text(countPhrase(clause.people.length, "joined and left"))];
    case "left":
      return [text(countPhrase(clause.people.length, "left"))];
    case "quit":
      return [text(countPhrase(clause.people.length, "quit"))];
    case "reconnected":
      return [text(countPhrase(clause.people.length, "reconnected"))];
    case "rejoined":
      return [text(countPhrase(clause.people.length, "rejoined"))];
    case "nick":
      return [
        text(
          `${clause.changes.length} nick ${clause.changes.length === 1 ? "change" : "changes"}`,
        ),
      ];
    case "modes":
      return [
        text(
          `${clause.changes.length} mode ${clause.changes.length === 1 ? "change" : "changes"}`,
        ),
      ];
    case "invited":
      return [text(countPhrase(clause.people.length, "invited"))];
    default: {
      const exhaustive: never = clause;
      return exhaustive;
    }
  }
}

function expandedClauseWords(
  clause: RunClauses[number],
  options: SystemLineWordOptions,
): SystemLineSegment[][] {
  switch (clause.type) {
    case "joined":
    case "joined_and_left":
    case "reconnected":
    case "rejoined": {
      const verb = {
        joined: "joined",
        joined_and_left: "joined and left",
        reconnected: "reconnected",
        rejoined: "rejoined",
      }[clause.type];
      return clause.people.map((person) => [nick(person), text(` ${verb}`)]);
    }
    case "left":
    case "quit":
      return clause.people.map((departure) =>
        departureWords([departure], clause.type),
      );
    case "nick":
      return clause.changes.map(({ old, new: next }) =>
        old.me
          ? [text("You are now "), nick(next)]
          : [nick(old), text(" is now "), nick(next)],
      );
    case "modes":
      return clause.changes.map((change) =>
        modeWords(clause.actor, [change], options),
      );
    case "invited":
      return clause.people.map((person) => [
        ...actorWords(clause.actor),
        text(" invited "),
        nick(person),
      ]);
    default: {
      const exhaustive: never = clause;
      return exhaustive;
    }
  }
}

function countPhrase(count: number, verb: string): string {
  return `${count} ${count === 1 ? "person" : "people"} ${verb}`;
}
