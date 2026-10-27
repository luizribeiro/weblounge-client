# 08 — Theming and tokens

Status: proposed for milestone 1 review.

## Problem

Five visually distinct themes must drive every rendered value without component-specific colours
or theme branches. A theme swap should update CSS variables without rebuilding the Solid component
tree. The same data must be usable by a future native UI, settings preview cards, onboarding, and
visual tests.

Themes describe appearance; they do not contain layout density, user settings, feature flags, or
component markup. Density is subsystem 09.

## Theme files and schema

Each theme is one checked JSON file under `app/themes/<id>.json`. JSON is chosen because Rust,
TypeScript, build tools, and potential native UIs can consume it without executing code. A build
step validates every file against a closed Rust schema and generates:

- a typed TypeScript registry;
- a Rust registry for non-web consumers;
- one CSS custom-property block per theme;
- a deterministic preview palette.

Generation fails for missing, unknown, invalid, or duplicate fields. Components never import raw
JSON.

```rust
#[serde(deny_unknown_fields)]
pub struct ThemeDefinition {
    pub id: ThemeId,
    pub label_key: MessageKey,
    pub description_key: MessageKey,
    pub appearance: ThemeAppearance,
    pub colors: ColorTokens,
    pub typography: TypographyTokens,
    pub shape: ShapeTokens,
    pub effects: EffectTokens,
    pub nick_palette: NonEmptyVec<CssColor>,
}

pub enum ThemeId { Lounge, LoungeNight, Modern, Terminal, Retro }
pub enum ThemeAppearance { Light, Dark }

pub struct ColorTokens {
    pub background: CssColor,
    pub surface: CssColor,
    pub panel: CssColor,
    pub panel_foreground: CssColor,
    pub panel_muted: CssColor,
    pub panel_border: CssColor,
    pub panel_alternate: CssColor,
    pub foreground: CssColor,
    pub muted: CssColor,
    pub border: CssColor,
    pub accent: CssColor,
    pub accent_foreground: CssColor,
    pub selection: CssColor,
    pub selection_foreground: CssColor,
    pub mention_background: CssColor,
    pub unread: CssColor,
    pub input_background: CssColor,
    pub chip: CssColor,
    pub code_background: CssColor,
    pub online: CssColor,
    pub self_nick: CssColor,
    pub error: CssColor,
}

pub struct TypographyTokens {
    pub ui_family: FontStack,
    pub title_family: FontStack,
    pub message_family: FontStack,
    pub monospace_family: FontStack,
    pub section_label: SectionLabelStyle,
    pub base_px: BaseFontPx,
}

pub struct ShapeTokens {
    pub control_radius: CssLength,
    pub avatar_radius: CssLength,
    pub composer_radius: CssLength,
    pub overlay_radius: CssLength,
    pub pill_radius: CssLength,
}

pub struct EffectTokens {
    pub overlay_shadow: CssShadow,
    pub network_icon_ring: CssShadow,
    pub overlay_backdrop: CssColor,
}
```

`CssColor`, `CssLength`, and `CssShadow` are validated value types with intentionally small
grammars. Colours accept hex, `rgb[a]`, and `oklch`; lengths used here accept nonnegative `px`,
`rem`, or `%`; shadows reject URLs and declarations. This prevents theme data from becoming an
arbitrary CSS injection surface.

The prototype appendix supplies the initial values. Existing names map as follows:
`bg → background`, `fg → foreground`, `panelAlt → panel_alternate`, `sel → selection`,
`mentionBg → mention_background`, `inputBg → input_background`, `codeBg → code_background`, and
`iconRing → network_icon_ring`. Generated output retains no second alias set.

## Theme selection

```rust
pub enum ThemePreference {
    System { light: ThemeId, dark: ThemeId },
    Fixed(ThemeId),
}

impl Default for ThemePreference {
    fn default() -> Self {
        Self::System { light: ThemeId::Lounge, dark: ThemeId::LoungeNight }
    }
}
```

Only opposite-appearance themes may populate `System`; validation rejects Lounge/Lounge, for
example. A fixed theme never changes with the OS. The resolved theme is a UI projection of the
preference plus `matchMedia('(prefers-color-scheme: dark)')`.

The root element receives `data-theme="lounge"` and `color-scheme: light` (or dark). System changes
replace that attribute synchronously. The media-query listener is installed once by the app shell
and removed on teardown. It does not write settings when the OS changes.

The onboarding palette is a named surface mapping derived from Lounge/Lounge Night tokens, not a
sixth hard-coded theme. Its `paper`, `ink`, `line`, `panel`, `soft`, `accent`, `signal`, and header
roles are declared in a small `OnboardingThemeRoles` mapping validated against the same token
registry.

## CSS variable mapping

Generated CSS uses a stable prefix and semantic names:

```css
:root[data-theme="lounge"] {
  --wl-color-bg: /* generated */;
  --wl-color-surface: /* generated */;
  --wl-color-fg: /* generated */;
  --wl-color-muted: /* generated */;
  --wl-color-border: /* generated */;
  --wl-color-accent: /* generated */;
  --wl-font-ui: /* generated */;
  --wl-font-mono: /* generated */;
  --wl-radius-control: /* generated */;
  --wl-shadow-overlay: /* generated */;
}
```

The comments above stand for generated values; production component CSS may not contain raw
colour literals. Biome plus a custom style check rejects hex/rgb/hsl/oklch literals outside theme
files and generated CSS. It also rejects unprefixed custom properties in component modules.

CSS Modules are the only component styling mechanism. A component may use semantic variables,
layout primitives, and density variables; it may not branch on `data-theme`, import a theme, or
invent a component colour. If a semantic role is genuinely missing, add it to the schema and all
five files in one reviewed theme change.

Theme changes mutate variables only. Solid state stores `ThemePreference` and the resolved ID for
settings/ARIA; message rows do not subscribe to individual theme values.

## Nick colours

```rust
pub struct NickColorIndex(u8);

pub fn nick_color_index(network_salt: NetworkColorSalt, identity: &NickIdentity) -> NickColorIndex;

pub enum NickIdentity<'a> {
    Account(&'a str),
    Nick { casemapped: &'a str },
}
```

The engine computes a stable palette index, preferring account identity and otherwise using
papo's server casemapping result. It never emits a colour. The UI maps the index modulo the active
theme's nonempty palette. The user's own nick always uses `--wl-color-self-nick`. Mentions of other
nicks use the same index as their message author/member-list appearance.

Changing theme preserves indexes, so colours change palette consistently without state churn.
Changing account identity may change the stable colour; a mere typed nick rename without an
account retains the engine's identity key where continuity is known.

## Theme registry and preview cards

```ts
export interface ThemeRegistryEntry {
  readonly id: ThemeId;
  readonly labelKey: MessageKey;
  readonly descriptionKey: MessageKey;
  readonly appearance: "light" | "dark";
  readonly preview: ThemePreviewTokens;
}

export interface ThemePreviewTokens {
  readonly background: CssColor;
  readonly panel: CssColor;
  readonly foreground: CssColor;
  readonly muted: CssColor;
  readonly accent: CssColor;
  readonly selection: CssColor;
  readonly border: CssColor;
  readonly radius: CssLength;
  readonly fontFamily: FontStack;
}
```

Settings enumerates the generated registry; there is no hand-maintained theme list. Preview cards
are small DOM compositions styled through inline custom properties from `preview`, not screenshots
and not a live nested app. The card has an accessible text label; its decorative mini-layout is
`aria-hidden`.

Adding a theme means adding one valid JSON file and any licensed font assets. Registry order is an
explicit generated manifest order, so filesystem ordering cannot change settings unexpectedly.

## Fonts and layout stability

Fonts are self-hosted, subset to the required scripts, fingerprinted, and preloaded only for the
resolved initial theme. Every stack ends in metric-compatible system fallbacks. `@font-face` uses
`font-display: swap`; ascent, descent, line-gap, and size adjustments are generated where font
metrics require them. Containers reserve dimensions from density tokens, so a font swap cannot
move pane chrome or the unread marker.

Lounge uses Inter plus the system monospace stack; Modern uses Geist/Geist Mono; Terminal uses IBM
Plex Mono throughout; Retro uses Work Sans, Fraunces, and Courier Prime as specified by the brief.
Font licences and source versions are recorded beside the assets before shipping.

Browser zoom and Dynamic Type scale from the theme base through `rem`. The numeric base is not
copied into fixed component pixel sizes. Mobile's `base + 1px` is a shell-level typography scale
token derived from the active theme, not a separate theme.

## Network icons and brand assets

```ts
export type NetworkIcon =
  | { readonly kind: "remote"; readonly url: HttpsUrl; readonly backing: IconBacking }
  | { readonly kind: "letter"; readonly letter: string; readonly colorIndex: number }
  | { readonly kind: "brand"; readonly asset: BrandAsset };

export type IconBacking = "none" | "lightPlate" | "unknown";
```

Remote `draft/ICON` images are content, not theme data. They render unchanged with the theme's
`network_icon_ring`; dark themes therefore retain the subtle inner ring from the prototype.
Downloaded images are decoded off the main interaction path and inspected once for meaningful
alpha. Transparent images get a neutral light backing plate token. The decision and cache key are
stored with the image cache, not recalculated on render. Failure becomes a themed letter tile.

Remote SVG is displayed as an image resource, never injected into the DOM. URL, content-type,
size, pixel dimensions, and redirect limits belong to the later image/cache security design.

The app chair, favicon, illustration, and wordmark originate from `~/weblounge/web/images/` and
are copied as versioned project assets during implementation. They may have approved light/dark
variants or use `currentColor`; components must not recolour arbitrary remote network icons.

## Accessibility and contrast

Every theme is checked for WCAG contrast on actual semantic pairs: foreground/background,
foreground/surface, panel foreground/panel, muted text on its surfaces, selection foreground,
accent controls, error text, unread lines, and focus rings. Nick palettes are checked on normal,
mention, selection, and panel backgrounds. A palette colour that cannot meet text contrast is
restricted to decorative identity and paired with non-colour identification.

High-contrast media preferences map to a small generated override layer using existing semantic
roles; components still do not branch. Focus visibility, online status, mentions, and errors never
rely on colour alone.

## Boundaries

This subsystem owns the closed theme schema, source files, validation/generation, registry, CSS
variable mapping, theme resolution, preview tokens, font declarations, and icon presentation
policy. It must not own density, pane geometry, component markup, network fetching, settings
persistence, IRC capability detection, or engine nick hashing beyond consuming an index.

## Testing

- Schema tests accept all five source themes and reject missing/extra/unsafe values and empty nick
  palettes.
- Generated files must be reproducible and clean in CI.
- A style lint scans component CSS for raw colours, theme selectors, and unknown variables.
- Component tests switch all themes without remounting and verify system preference listener
  cleanup.
- Playwright screenshots cover every theme × density × shell at standard and high contrast, with
  deterministic font loading.
- Automated contrast tests evaluate every declared semantic pair and nick palette context.
- Icon tests cover opaque, transparent, dark, failed, oversized, and malicious SVG resources.
- Performance tests assert a theme swap causes no message-row reconciliation storm or layout shift.

## Out of scope

A theme editor, downloadable third-party themes, user-authored CSS, per-network themes, animated
themes, and native UI rendering are not planned for milestone 1.

## Questions for Luiz

1. Should “System” be a visible sixth picker choice (proposed), or only the implicit first-run
   default with any manual choice becoming fixed?
2. Confirm the repository may redistribute Inter, Geist, IBM Plex Mono, Work Sans, Fraunces, and
   Courier Prime; otherwise approve system fallbacks for affected themes.
3. Should the onboarding palette track Lounge/Lounge Night exactly, or preserve the slightly
   different current website palette in a dedicated validated role file?
4. Is remote network-icon alpha inspection worth shipping in the first themed milestone, or may
   the first slice always use the backing plate until the cache design lands?
