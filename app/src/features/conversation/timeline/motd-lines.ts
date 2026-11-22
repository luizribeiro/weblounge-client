import type { LineEvent } from "../../../engine/generated/LineEvent";

export type MotdCardEvent = Extract<LineEvent, { type: "motd" }>;

const foldedLineCount = 4;

export function motdFolds(card: MotdCardEvent): boolean {
  return card.lines.length > foldedLineCount;
}

export function motdShownLines(
  card: MotdCardEvent,
  expanded: boolean,
): readonly string[] {
  return expanded ? card.lines : card.lines.slice(0, foldedLineCount);
}
