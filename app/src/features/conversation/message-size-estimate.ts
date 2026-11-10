import {
  type DensityId,
  densityDefaults,
  densityPresets,
} from "../../density/density";
import type { MessageProjection } from "../../engine/protocol";

type EstimatedMessage = Pick<
  MessageProjection,
  "delivery" | "kind" | "reactions" | "text"
>;

const baseFontSize = 14;
const listInlinePadding = 28;
const mobileListInlinePadding = 32;
const rowInlinePadding = 16;
const nickColumnWidth = 112;
const gridGapWidth = 30;
const fullWidthIndent = 58;

export function estimateMessageHeight(
  message: EstimatedMessage,
  viewportWidth: number,
  density: DensityId,
  presentation: "desktop" | "mobile" = "desktop",
  startsMobileGroup = true,
): number {
  const preset = densityPresets[density];
  const fontSize = baseFontSize + Number.parseFloat(preset.fontDelta);
  const lineHeight = fontSize * Number.parseFloat(preset.lineHeight);
  const verticalPadding = 2 * Number.parseFloat(preset.oneLineRowPadding);
  const rowWidth = Math.max(
    viewportWidth -
      (presentation === "mobile" ? mobileListInlinePadding : listInlinePadding),
    1,
  );
  if (typeof message.kind === "object") {
    const systemFontSize = 12;
    const charactersPerLine = Math.max(
      1,
      Math.floor(rowWidth / (systemFontSize * 0.55)),
    );
    return (
      estimatedLines(message.text, charactersPerLine) * 18 +
      Number.parseFloat(preset.mobileContinuationPadding)
    );
  }
  if (presentation === "mobile" && isSenderRow(message.kind)) {
    const textWidth = Math.max(
      rowWidth -
        (message.kind === "text" && !startsMobileGroup
          ? deliveryChromeWidth(message.delivery)
          : 0),
      fontSize * 4,
    );
    const charactersPerLine = Math.max(
      1,
      Math.floor(textWidth / (fontSize * 0.55)),
    );
    const textHeight = Math.ceil(
      estimatedLines(message.text, charactersPerLine) * lineHeight,
    );
    const topPadding = Number.parseFloat(
      startsMobileGroup
        ? preset.mobileGroupTopPadding
        : preset.mobileContinuationPadding,
    );
    const headerHeight = startsMobileGroup
      ? lineHeight + Number.parseFloat(preset.mobileHeaderGap)
      : 0;
    return (
      topPadding +
      headerHeight +
      textHeight +
      estimatedReactionHeight(message, textWidth, presentation)
    );
  }
  const textWidth = Math.max(
    rowWidth -
      rowInlinePadding -
      messageChromeWidth(message.kind, fontSize) -
      (message.kind === "text" ? deliveryChromeWidth(message.delivery) : 0),
    fontSize * 4,
  );
  const charactersPerLine = Math.max(
    1,
    Math.floor(textWidth / (fontSize * 0.55)),
  );
  const lines = estimatedLines(message.text, charactersPerLine);
  const textHeight = Math.max(
    28,
    Math.ceil(lines * lineHeight + verticalPadding),
  );
  const deliveryHeight =
    message.kind === "action" &&
    message.delivery !== "received" &&
    message.delivery !== "confirmed"
      ? Math.ceil(11 * Number.parseFloat(preset.lineHeight))
      : 0;
  return (
    textHeight +
    deliveryHeight +
    estimatedReactionHeight(message, textWidth, presentation)
  );
}

export function messageSizeRevision(
  message: EstimatedMessage,
  startsMobileGroup?: boolean,
): string {
  const reactions = message.reactions
    ?.map((reaction) => `${reaction.text}:${reaction.actors.length}`)
    .join("\u0001");
  return `${JSON.stringify(message.kind)}\u0000${message.text}\u0000${message.delivery}\u0000${reactions ?? ""}\u0000${startsMobileGroup ?? ""}`;
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
  if (!isSenderRow(kind)) return fullWidthIndent;
  const timeColumnWidth = 9 * fontSize * 0.62;
  return timeColumnWidth + nickColumnWidth + gridGapWidth;
}

function isSenderRow(kind: EstimatedMessage["kind"]): boolean {
  return kind === "text" || kind === "irc_notice";
}

function deliveryChromeWidth(delivery: EstimatedMessage["delivery"]): number {
  if (delivery === "received" || delivery === "confirmed") return 0;
  const labelCharacters = delivery === "optimistic" ? 8 : 14;
  return labelCharacters * 11 * 0.6;
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

function estimatedReactionHeight(
  message: EstimatedMessage,
  availableWidth: number,
  presentation: "desktop" | "mobile",
): number {
  const reactions = message.reactions ?? [];
  if (reactions.length === 0) return 0;
  const mobile = presentation === "mobile";
  const gap = mobile ? 6 : 4;
  const chipHeight = mobile ? 32 : 22;
  const padding = mobile ? 22 : 16;
  let rows = 1;
  let occupied = 0;
  for (const reaction of reactions) {
    const characters = Math.min(Array.from(reaction.text).length, 17);
    const width = Math.min(
      availableWidth,
      Math.max(chipHeight, padding + characters * (mobile ? 9 : 7) + 14),
    );
    if (occupied > 0 && occupied + gap + width > availableWidth) {
      rows += 1;
      occupied = width;
    } else {
      occupied += (occupied > 0 ? gap : 0) + width;
    }
  }
  return 4 + rows * chipHeight + (rows - 1) * gap + (mobile ? 8 : 2);
}
