import type { SystemLine } from "../../../engine/generated/SystemLine";
import { eventWords } from "./system-line-event-words";
import { runWords } from "./system-line-run-words";
import type {
  SystemLineSegment,
  SystemLineWordOptions,
  SystemLineWords,
} from "./system-line-word-types";

export type {
  SystemLineAction,
  SystemLineIcon,
  SystemLineSegment,
  SystemLineWords,
} from "./system-line-word-types";

export function systemLineWords(
  line: SystemLine,
  options: SystemLineWordOptions = {},
): SystemLineWords {
  return line.type === "event"
    ? eventWords(line.event, options)
    : runWords(line.clauses, options);
}

export function systemLineText(segments: readonly SystemLineSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}
