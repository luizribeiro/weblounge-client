import type { RunClauses } from "../../../engine/generated/RunClauses";
import { clauseWords } from "./system-line-clause-words";
import { expandedRunWords } from "./system-line-expanded-words";
import { joinSegments } from "./system-line-segments";
import type {
  SystemLineIcon,
  SystemLineWordOptions,
  SystemLineWords,
} from "./system-line-word-types";

export function runWords(
  clauses: RunClauses,
  options: SystemLineWordOptions,
): SystemLineWords {
  const icon = runIcon(clauses);
  if (options.expanded === true && clauses.some(clauseHasOverflow))
    return expandedRunWords(clauses, options, icon);
  return {
    details: [],
    icon,
    segments: joinSegments(
      clauses.map((clause) => clauseWords(clause, options)),
      " · ",
    ),
    warning: false,
  };
}

function clauseHasOverflow(clause: RunClauses[number]): boolean {
  switch (clause.type) {
    case "joined":
    case "joined_and_left":
    case "reconnected":
    case "rejoined":
    case "invited":
    case "left":
    case "quit":
      return clause.people.length > 4;
    case "nick":
    case "modes":
      return clause.changes.length > 3;
    default: {
      const exhaustive: never = clause;
      return exhaustive;
    }
  }
}

function runIcon(clauses: RunClauses): SystemLineIcon {
  if (clauses.length !== 1) return "people";
  const clause = clauses[0];
  if (clause === undefined) return "people";
  switch (clause.type) {
    case "joined":
    case "rejoined":
      return "join";
    case "left":
    case "joined_and_left":
      return "part";
    case "quit":
    case "reconnected":
      return "quit";
    case "nick":
      return "nick";
    case "invited":
      return "invite";
    case "modes": {
      const type = clause.changes[0]?.meaning.type;
      return type === "ban" || type === "ban_exception" || type === "quiet"
        ? "ban"
        : "mode";
    }
    default: {
      const exhaustive: never = clause;
      return exhaustive;
    }
  }
}
