export type ThemeId = string & { readonly themeId: unique symbol };
export type CssColor = string & { readonly cssColor: unique symbol };

export interface ThemeDefinition {
  readonly id: ThemeId;
  readonly name: string;
  readonly order: number;
  readonly appearance: "light" | "dark";
  readonly colors: Readonly<Record<ColorToken, CssColor>>;
  readonly typography: Readonly<Record<TypographyToken, string>>;
  readonly shape: Readonly<Record<ShapeToken, string>>;
  readonly effects: Readonly<Record<EffectToken, string>>;
  readonly nickPalette: readonly [CssColor, ...CssColor[]];
  readonly onboarding: Readonly<Record<OnboardingToken, CssColor>> &
    Readonly<Partial<Record<LightOnboardingToken, CssColor>>>;
}

const colorTokens = [
  "bg",
  "surface",
  "panel",
  "panelFg",
  "panelMuted",
  "panelBorder",
  "panelAlt",
  "fg",
  "muted",
  "border",
  "accent",
  "accentFg",
  "selection",
  "selectionFg",
  "mentionBg",
  "overlayScrim",
  "unread",
  "inputBg",
  "chip",
  "codeBg",
  "online",
  "selfNick",
  "error",
  "focusRing",
] as const;
const typographyTokens = [
  "ui",
  "mono",
  "base",
  "sectionFamily",
  "sectionSize",
  "sectionTransform",
  "sectionTracking",
] as const;
const shapeTokens = [
  "control",
  "avatar",
  "composer",
  "palette",
  "pill",
] as const;
const effectTokens = ["overlayShadow", "iconRing"] as const;
const onboardingTokens = [
  "paper",
  "ink",
  "muted",
  "line",
  "panel",
  "accent",
  "header",
] as const;
const lightOnboardingTokens = ["soft", "signal"] as const;

type ColorToken = (typeof colorTokens)[number];
type TypographyToken = (typeof typographyTokens)[number];
type ShapeToken = (typeof shapeTokens)[number];
type EffectToken = (typeof effectTokens)[number];
type OnboardingToken = (typeof onboardingTokens)[number];
type LightOnboardingToken = (typeof lightOnboardingTokens)[number];

const themeFiles = import.meta.glob("../../themes/*.json", {
  eager: true,
  import: "default",
});

export const motionTokens = {
  fade: "200ms",
  members: "220ms",
  previewFade: "420ms",
  pushIn: "280ms",
  pushOut: "230ms",
  suggestions: "120ms",
  standardCurve: "cubic-bezier(0.2, 0.8, 0.2, 1)",
} as const;

export const themes = buildRegistry(themeFiles);
export const nickPaletteSize = sharedNickPaletteSize(themes);

export function themeStyleSheet(registry = themes): string {
  const motion = Object.entries(motionTokens)
    .map(([token, value]) => `${customProperty("motion", token)}:${value}`)
    .join(";");
  const themeRules = registry
    .map((theme) => {
      const values = [
        `color-scheme:${theme.appearance}`,
        ...tokenProperties("color", theme.colors),
        ...tokenProperties("font", theme.typography),
        ...tokenProperties("radius", theme.shape),
        ...tokenProperties("effect", theme.effects),
        ...theme.nickPalette.map(
          (value, index) => `--wl-nick-${index}:${value}`,
        ),
      ];
      return `:root[data-theme="${theme.id}"]{${values.join(";")}}`;
    })
    .join("");
  return `:root{${motion}}${themeRules}@media(prefers-reduced-motion:reduce){:root{--wl-motion-push-in:0ms;--wl-motion-push-out:0ms;--wl-motion-members:0ms;--wl-motion-fade:0ms;--wl-motion-preview-fade:0ms;--wl-motion-suggestions:0ms}}`;
}

function buildRegistry(
  files: Readonly<Record<string, unknown>>,
): readonly ThemeDefinition[] {
  const registry = Object.entries(files).map(([path, value]) =>
    parseTheme(path, value),
  );
  const ids = new Set(registry.map((theme) => theme.id));
  const orders = new Set(registry.map((theme) => theme.order));
  if (ids.size !== registry.length) throw new Error("duplicate theme id");
  if (orders.size !== registry.length) throw new Error("duplicate theme order");
  return registry.sort((first, second) => first.order - second.order);
}

function sharedNickPaletteSize(registry: readonly ThemeDefinition[]): number {
  const sizes = new Set(registry.map((theme) => theme.nickPalette.length));
  if (sizes.size !== 1)
    throw new Error("theme nick palettes must have equal sizes");
  const size = registry[0]?.nickPalette.length;
  if (size === undefined) throw new Error("at least one theme is required");
  return size;
}

function parseTheme(path: string, value: unknown): ThemeDefinition {
  if (!isRecord(value)) throw new Error(`${path}: theme must be an object`);
  assertKeys(
    value,
    [
      "id",
      "name",
      "order",
      "appearance",
      "colors",
      "typography",
      "shape",
      "effects",
      "nickPalette",
      "onboarding",
    ],
    path,
  );
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(value.id)) {
    throw new Error(`${path}: invalid id`);
  }
  if (typeof value.name !== "string" || value.name === "") {
    throw new Error(`${path}: invalid name`);
  }
  if (!Number.isInteger(value.order) || typeof value.order !== "number") {
    throw new Error(`${path}: invalid order`);
  }
  if (value.appearance !== "light" && value.appearance !== "dark") {
    throw new Error(`${path}: invalid appearance`);
  }
  const nickPalette = parseColorArray(value.nickPalette, `${path}.nickPalette`);
  return {
    id: value.id as ThemeId,
    name: value.name,
    order: value.order,
    appearance: value.appearance,
    colors: parseTokenRecord(value.colors, colorTokens, true, `${path}.colors`),
    typography: parseTokenRecord(
      value.typography,
      typographyTokens,
      false,
      `${path}.typography`,
    ),
    shape: parseTokenRecord(value.shape, shapeTokens, false, `${path}.shape`),
    effects: parseTokenRecord(
      value.effects,
      effectTokens,
      false,
      `${path}.effects`,
    ),
    nickPalette,
    onboarding: parseTokenRecord(
      value.onboarding,
      value.appearance === "light"
        ? [...onboardingTokens, ...lightOnboardingTokens]
        : onboardingTokens,
      true,
      `${path}.onboarding`,
    ) as ThemeDefinition["onboarding"],
  };
}

function parseTokenRecord<const Token extends string>(
  value: unknown,
  tokens: readonly Token[],
  colors: boolean,
  path: string,
): Readonly<Record<Token, CssColor>> & Readonly<Record<Token, string>> {
  if (!isRecord(value)) throw new Error(`${path}: tokens must be an object`);
  assertKeys(value, tokens, path);
  for (const token of tokens) {
    const item = value[token];
    if (typeof item !== "string" || item === "") {
      throw new Error(`${path}.${token}: token must be a nonempty string`);
    }
    if (colors && !isColor(item)) {
      throw new Error(`${path}.${token}: invalid color`);
    }
  }
  return value as Readonly<Record<Token, CssColor>> &
    Readonly<Record<Token, string>>;
}

function parseColorArray(
  value: unknown,
  path: string,
): readonly [CssColor, ...CssColor[]] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isColor)) {
    throw new Error(`${path}: palette must contain colors`);
  }
  return value as [CssColor, ...CssColor[]];
}

function assertKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    throw new Error(`${path}: expected ${wanted.join(", ")}`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isColor(value: unknown): value is CssColor {
  return (
    typeof value === "string" &&
    (/^#[0-9a-f]{6}$/i.test(value) || /^rgba?\([0-9., ]+\)$/i.test(value))
  );
}

function tokenProperties(
  group: string,
  values: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(values).map(
    ([token, value]) => `${customProperty(group, token)}:${value}`,
  );
}

function customProperty(group: string, token: string): string {
  return `--wl-${group}-${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}
