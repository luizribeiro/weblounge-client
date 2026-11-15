import { type DensityId, densityPresets } from "../../../density/density";
import type { SystemProjection } from "../../../engine/generated/SystemProjection";
import type { RowSpacing } from "./row-spacing";
import { systemLineText, systemLineWords } from "./system-line-words";

const characterWidthFactor = 0.55;
const lineHeight = 20;

export function estimateSystemLineHeight(
  system: SystemProjection,
  viewportWidth: number,
  density: DensityId,
  presentation: "desktop" | "mobile",
  expanded: boolean,
  canRejoin: boolean,
  spacing: RowSpacing,
): number {
  const preset = densityPresets[density];
  const top = padding(preset, presentation, spacing);
  if (system.line.type === "event" && system.line.event.type === "topic_card")
    return (
      top +
      estimateCardHeight(system.line.event.topic, viewportWidth, presentation)
    );
  const textWidth = Math.max(
    presentation === "mobile" ? viewportWidth - 58 : viewportWidth - 248,
    80,
  );
  const fontSize = presentation === "mobile" ? 14 : 13;
  const charactersPerLine = Math.max(
    1,
    Math.floor(textWidth / (fontSize * characterWidthFactor)),
  );
  const words = systemLineWords(system.line, {
    canRejoin,
    expanded,
    includeRawModes: presentation === "desktop",
  });
  const texts = [words.segments, ...words.details].map((segments) =>
    systemLineText(segments),
  );
  if (words.body !== null) texts.push(words.body);
  const contentLines = texts.reduce(
    (total, text) =>
      total + Math.max(1, Math.ceil(text.length / charactersPerLine)),
    0,
  );
  const detailGaps = words.details.length * 4 + (words.body === null ? 0 : 2);
  return contentLines * lineHeight + detailGaps + top;
}

const cardHeaderHeight = 18;
const cardLineHeight = 21;
const cardFontSize = 14;
const cardMaxWidth = 620;
const cardBorders = 2;
const cardPadding = {
  desktop: { block: 16, inline: 24, gap: 4 },
  mobile: { block: 20, inline: 24, gap: 6 },
} as const;
const mobileTranscriptInline = 32;
const desktopTextColumnOffset = 248;

function estimateCardHeight(
  topic: string,
  viewportWidth: number,
  presentation: "desktop" | "mobile",
): number {
  const padding = cardPadding[presentation];
  const outerWidth =
    presentation === "mobile"
      ? viewportWidth - mobileTranscriptInline
      : Math.min(viewportWidth - desktopTextColumnOffset, cardMaxWidth);
  const innerWidth = Math.max(outerWidth - padding.inline - cardBorders, 80);
  const charactersPerLine = Math.max(
    1,
    Math.floor(innerWidth / (cardFontSize * characterWidthFactor)),
  );
  const lines = Math.max(1, Math.ceil(topic.length / charactersPerLine));
  return (
    padding.block +
    cardBorders +
    cardHeaderHeight +
    padding.gap +
    lines * cardLineHeight
  );
}

export function systemLineSizeRevision(
  itemId: number,
  contentVersion: number,
  expanded: boolean,
  canRejoin: boolean,
  previousFamily: string,
  presentation: "desktop" | "mobile",
): string {
  return `${itemId}:${contentVersion}:${expanded}:${canRejoin}:${previousFamily}:${presentation}`;
}

function padding(
  preset: (typeof densityPresets)[DensityId],
  presentation: "desktop" | "mobile",
  spacing: RowSpacing,
): number {
  if (presentation === "mobile") {
    if (spacing === "after-divider") return 0;
    return Number.parseFloat(
      spacing === "after-line"
        ? preset.mobileLineGapPadding
        : preset.mobileLineTopPadding,
    );
  }
  return (
    (spacing === "after-divider" ? 1 : 2) *
    Number.parseFloat(preset.oneLineRowPadding)
  );
}
