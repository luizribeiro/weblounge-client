import {
  type DensityId,
  densityDefaults,
  densityPresets,
} from "../../density/density";

interface EstimatedMessage {
  readonly kind: "action" | "notice" | "text";
  readonly text: string;
}

const baseFontSize = 14;
const listInlinePadding = 28;
const rowInlinePadding = 16;
const nickColumnWidth = 112;
const gridGapWidth = 30;
const fullWidthIndent = 58;

export function estimateMessageHeight(
  message: EstimatedMessage,
  viewportWidth: number,
  density: DensityId,
): number {
  const preset = densityPresets[density];
  const fontSize = baseFontSize + Number.parseFloat(preset.fontDelta);
  const lineHeight = fontSize * Number.parseFloat(preset.lineHeight);
  const verticalPadding = 2 * Number.parseFloat(preset.oneLineRowPadding);
  const rowWidth = Math.max(viewportWidth - listInlinePadding, 1);
  const textWidth = Math.max(
    rowWidth - rowInlinePadding - messageChromeWidth(message.kind, fontSize),
    fontSize * 4,
  );
  const charactersPerLine = Math.max(
    1,
    Math.floor(textWidth / (fontSize * 0.55)),
  );
  const lines = estimatedLines(message.text, charactersPerLine);
  return Math.max(28, Math.ceil(lines * lineHeight + verticalPadding));
}

export function currentMessageDensity(root: HTMLElement): DensityId {
  const density = root.dataset.messageDensity;
  if (density === "compact" || density === "comfortable" || density === "cozy")
    return density;
  return densityDefaults.message;
}

function messageChromeWidth(
  kind: EstimatedMessage["kind"],
  fontSize: number,
): number {
  if (kind !== "text") return fullWidthIndent;
  const timeColumnWidth = 9 * fontSize * 0.62;
  return timeColumnWidth + nickColumnWidth + gridGapWidth;
}

function estimatedLines(text: string, charactersPerLine: number): number {
  return text
    .split("\n")
    .reduce(
      (lines, segment) =>
        lines + Math.max(1, Math.ceil(segment.length / charactersPerLine)),
      0,
    );
}
