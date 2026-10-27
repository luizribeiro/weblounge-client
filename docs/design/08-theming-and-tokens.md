# 08 — Theming and tokens

Status: revised for milestone 1 review.

## Problem

Themes must drive every rendered colour, font, radius, and effect without component branches. A
theme swap changes CSS variables without rebuilding the Solid tree. Adding a theme must require
one theme file, not a manifest edit or Rust code change.

Density is subsystem 09. Themes contain no layout settings, capability flags, or component markup.

## Theme files

Each theme is one checked JSON file at `app/themes/<id>.json`:

```ts
export interface ThemeDefinition {
  readonly id: ThemeId;
  readonly name: string;
  readonly order: number;
  readonly appearance: "light" | "dark";
  readonly colors: ColorTokens;
  readonly typography: TypographyTokens;
  readonly shape: ShapeTokens;
  readonly effects: EffectTokens;
  readonly nickPalette: readonly [CssColor, ...CssColor[]];
  readonly onboarding?: OnboardingTokens;
}
```

A build-time TypeScript validator rejects missing, unknown, duplicate, or invalid values and emits
the typed UI registry and CSS custom-property blocks. It discovers files from the directory;
`order` makes picker order deterministic. Names live in the file, so there is no separate theme
manifest or message-key registration. A future native UI may consume the same JSON directly, but
milestone 1 has no Rust theme registry.

The schema covers the appendix token set plus an explicit `focusRing` semantic colour. Initial
`focusRing` values use each theme's accent. The accepted milestone-1 colour grammar is the appendix
formats (hex and `rgb[a]` where needed); arbitrary CSS and `oklch` are not accepted.

`OnboardingTokens` is present on Lounge and Lounge Night and uses the onboarding appendix values
exactly, including the distinct dark `header: #0f1613`. It is not derived from the Lounge Night
chat palette and is not a sixth theme.

## CSS contract

Generated CSS uses stable semantic variables such as:

```css
:root[data-theme="lounge"] {
  --wl-color-bg: /* generated */;
  --wl-color-fg: /* generated */;
  --wl-color-accent: /* generated */;
  --wl-color-focus-ring: /* generated */;
  --wl-font-ui: /* generated */;
  --wl-radius-control: /* generated */;
}
```

CSS Modules are the only component styling mechanism. Components may consume theme and density
variables, but may not contain raw colours, select a theme ID, or import source JSON. A style check
rejects those violations. Missing semantic roles are added to every theme file in one reviewed
change.

The root carries `data-theme` and matching `color-scheme`. Theme changes mutate variables only;
message rows do not subscribe to individual values.

## Selection and system appearance

First run follows the OS: Lounge in light mode and Lounge Night in dark mode. A manual theme choice
becomes fixed. A visible “Match system” picker option is deferred as the brief specifies.

One `matchMedia('(prefers-color-scheme: dark)')` listener resolves the initial implicit preference,
updates the root synchronously, and is removed on teardown. OS changes do not rewrite a fixed user
choice.

## Nick colours

```rust
pub fn nick_color_index(name_rules: NameRules<'_>, nick: &str) -> NickColorIndex;
```

The engine hashes the server-casemapped nick, not account identity. Mentions in message text carry
only a nick, so this rule guarantees that the same visible nick receives the same palette index in
messages, mention spans, and member rows. The UI maps that index modulo the active nonempty palette;
the user's own nick uses `selfNick`.

Theme changes preserve indexes. A nick change may change the colour because the visible identity
changed; no account-only colour can be reproduced for a plain-text mention.

## Picker previews and fonts

The generated registry exposes a small preview token subset from each file. Settings renders DOM
preview cards from those tokens, not screenshots or nested apps. The decorative mini-layout is
`aria-hidden`; the control uses the theme's `name` as its label.

Fonts follow the brief: Inter, the system monospace stack, Geist/Geist Mono, IBM Plex Mono, Work
Sans, Fraunces, and Courier Prime. The named bundled font families use SIL OFL licensing and may be
redistributed. Assets are self-hosted, fingerprinted, subset where appropriate, and use metric
adjustments plus `font-display: swap` to avoid layout shift. Mobile's base `+1px` is a shell
typography variable, not another theme.

## Network icons and brand assets

Remote `draft/ICON` images are content. They render unchanged with the theme's `iconRing`; failures
fall back to a themed letter tile. The first themed milestone always uses the light backing-plate
token where needed rather than inspecting image alpha.

Remote SVG stays an image resource and is never injected into the DOM. Fetch limits and caching
belong to a later image-security design. App brand assets come from the paths named in
`AGENTS.md` and may use approved light/dark variants.

## Accessibility

Validation checks the actual foreground/background, panel, selection, accent-control, error,
unread, and focus-ring pairs. Nick colours are checked on message and panel surfaces; identity is
never conveyed by colour alone. Keyboard focus always uses the explicit focus-ring token.

## Boundaries

This subsystem owns the theme-file schema, build validation, generated registry/CSS, system
resolution, previews, font declarations, nick palette mapping, and icon presentation tokens. It
does not own density, component markup, image fetching, settings persistence, or capabilities.

## Testing

- Schema tests accept all five appendix themes and reject missing/extra/unsafe values, duplicate
  IDs/orders, and empty nick palettes.
- Generated registry/CSS output must be reproducible.
- Style lint rejects raw component colours, theme selectors, and unknown custom properties.
- Component tests switch themes without remounting and verify system-listener cleanup.
- Visual tests cover the implemented theme × density × shell matrix with deterministic fonts.
- Contrast tests include focus rings and nick palette contexts.
- Performance tests assert theme switching causes no message-row reconciliation or layout shift.

## Out of scope

Theme editors, downloadable themes, user CSS, per-network themes, and native rendering are not
part of milestone 1.

## Later

- Add a visible “Match system” setting with the full appearance settings milestone.
- Consider a Rust registry only when a native UI exists.
- Consider `oklch`, high-contrast override layers, and remote-icon alpha inspection after the
  initial theme system is measured and shipped.

## Decisions

- Keep system matching as the implicit first-run default; a visible option is a follow-up.
- Redistribute the brief's bundled fonts under their SIL OFL licences.
- Use the onboarding appendix values exactly as written.
- Defer remote-icon alpha inspection and use the backing-plate treatment initially.
