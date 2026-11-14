import { describe, expect, it } from "vitest";
import { type ThemeDefinition, themes } from "./theme-registry";

type ColorToken = keyof ThemeDefinition["colors"];

const textOnSurface = 4.5;
const nonTextOnSurface = 3;

const textPairs: readonly (readonly [ColorToken, ColorToken])[] = [
  ["fg", "bg"],
  ["fg", "surface"],
  ["muted", "surface"],
  ["fg", "inputBg"],
  ["fg", "chip"],
  ["fg", "mentionBg"],
  ["fg", "codeBg"],
  ["panelFg", "panel"],
  ["panelMuted", "panel"],
  ["selectionFg", "selection"],
  ["accentFg", "accent"],
  ["mentionBadgeFg", "mentionBadge"],
  ["error", "surface"],
  ["selfNick", "surface"],
];

const nonTextPairs: readonly (readonly [ColorToken, ColorToken])[] = [
  ["focusRing", "surface"],
  ["accent", "surface"],
  ["online", "panel"],
];

describe.each(themes)("$name contrast", (theme) => {
  it.each(textPairs)("reads %s on %s", (foreground, background) => {
    expect(
      contrast(theme.colors[foreground], theme.colors[background]),
    ).toBeGreaterThanOrEqual(textOnSurface);
  });

  it.each(nonTextPairs)("shows %s on %s", (foreground, background) => {
    expect(
      contrast(theme.colors[foreground], theme.colors[background]),
    ).toBeGreaterThanOrEqual(nonTextOnSurface);
  });

  it("reads every nick colour on the conversation surface", () => {
    for (const nick of theme.nickPalette) {
      expect(contrast(nick, theme.colors.surface), nick).toBeGreaterThanOrEqual(
        textOnSurface,
      );
    }
  });
});

describe("contrast", () => {
  it("matches the WCAG ratios of known pairs", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});

function contrast(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort(
    (a, b) => b - a,
  );
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

function luminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((start) =>
    linear(Number.parseInt(hex.slice(start, start + 2), 16) / 255),
  );
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

function linear(channel: number): number {
  return channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}
