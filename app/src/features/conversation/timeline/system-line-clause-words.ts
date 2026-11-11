import type { Departure } from "../../../engine/generated/Departure";
import type { Person } from "../../../engine/generated/Person";
import type { RunClauses } from "../../../engine/generated/RunClauses";
import { modeWords } from "./system-line-mode-words";
import {
  actorWords,
  joinSegments,
  nameList,
  nick,
  text,
} from "./system-line-segments";
import type {
  SystemLineSegment,
  SystemLineWordOptions,
} from "./system-line-word-types";

export function clauseWords(
  clause: RunClauses[number],
  options: SystemLineWordOptions,
): SystemLineSegment[] {
  switch (clause.type) {
    case "joined":
      return peopleWords(clause.people, "joined");
    case "joined_and_left":
      return peopleWords(clause.people, "joined and left");
    case "left":
      return departureWords(clause.people, "left");
    case "quit":
      return departureWords(clause.people, "quit");
    case "reconnected":
      return peopleWords(clause.people, "reconnected");
    case "rejoined":
      return peopleWords(clause.people, "rejoined");
    case "nick":
      return joinSegments(
        clause.changes.map(({ old, new: next }) =>
          old.me
            ? [text("You are now "), nick(next)]
            : [nick(old), text(" is now "), nick(next)],
        ),
        ", ",
      );
    case "modes":
      return modeWords(clause.actor, clause.changes, options);
    case "invited":
      return [
        ...actorWords(clause.actor),
        text(" invited "),
        ...peopleList(clause.people),
      ];
    default: {
      const exhaustive: never = clause;
      return exhaustive;
    }
  }
}

function peopleWords(
  people: readonly Person[],
  verb: string,
): SystemLineSegment[] {
  return [...peopleList(people), text(` ${verb}`)];
}

export function departureWords(
  departures: readonly Departure[],
  verb: string,
): SystemLineSegment[] {
  const words = peopleWords(
    departures.map(({ person }) => person),
    verb,
  );
  const reason = departures.length === 1 ? departures[0]?.reason : null;
  return reason === null || reason === undefined
    ? words
    : [...words, text(`: “${reason}”`)];
}

function peopleList(people: readonly Person[]): SystemLineSegment[] {
  const shownCount = people.length === 4 ? 4 : 3;
  const shown = people.slice(0, shownCount).map((person) => [nick(person)]);
  const hidden = people.length - shownCount;
  if (hidden >= 2) {
    shown.push([
      {
        kind: "button",
        action: "expand",
        accessibleName: `Show ${hidden} others`,
        text: `${hidden} others`,
      },
    ]);
  }
  return nameList(shown);
}
