# 08 — Theming and tokens

Status: revised for milestone 1 review.

## Problem

Themes must drive every rendered colour, font, radius, and effect without component branches. A
theme swap changes CSS variables without rebuilding the Solid tree. Adding a theme must require
one theme file, not a manifest edit or Rust code change.

Density is subsystem 09. Themes contain no layout settings, capability flags, or component markup.
This subsystem also owns the global semantic motion tokens named in subsystem 15; they travel
through the same generated CSS pipeline but are not duplicated in individual theme files.

## Theme files

Each theme is one checked JSON file at `app/themes/<id>.json`:

```ts
export interface ThemeDefinition {
  readonly id: ThemeId;
  readonly name: string;
  readonly description: string;
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

The schema covers the appendix token set plus an explicit `focusRing` semantic colour and
`mentionBadge` / `mentionBadgeFg` pair. The pair gives mention-severity count badges their red
treatment without coupling them to error UI. Initial `focusRing` values use each theme's accent.
`viewerScrim` and `viewerFg` are the image viewer's backdrop and the colour of the controls drawn
on it (design 30): near-black (black at 92%), much stronger than `overlayScrim`, with light text,
in every theme, as in photo viewers. Every theme, light ones included, uses the same values.
The shape tokens add `icon` (network logos and settings tiles) and `round`, the largest rounding a
theme allows: 999px in soft themes, its control radius in square ones. Pills, round buttons and the
phone's sheets and toasts use `round` directly or as a cap, `min(14px, var(--wl-radius-round))`, so
Terminal's square corners reach every surface. Typography adds `title`, the font of conversation,
panel and settings titles (Fraunces in Retro).
The accepted milestone-1 colour grammar is the appendix formats (hex and `rgb[a]` where needed);
arbitrary CSS and `oklch` are not accepted.

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
message rows do not subscribe to individual values. The generated sheet also emits the global
motion variables and their reduced-motion overrides.

## Shipped themes

In picker order: Lounge, Lounge Night, Black, Modern, Terminal, Retro. Lounge Night and Lounge are
the System pair. Modern, Terminal and Retro take the prototype's `THEMES` values; tokens the
prototype lacks follow each theme's own family (focus ring = accent, mention badge = the unread or
error red). Black is Lounge Night for OLED screens: `#000` for the app, surfaces and panels,
near-black only where layering needs it (`#0a0a0a` inputs and code, `#111` chips and panel
borders, `#1a1f1c` content borders and `#1a241d` selection), and Lounge Night's accent and text
colours, which already pass on black (fg 18.1:1, muted 9.7:1, accent 13.7:1, unread 10.1:1).
A unit test checks text pairs at 4.5:1 and indicators at 3:1 in every theme.

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
redistributed; the licences sit next to the files in `app/src/assets/fonts/`. Assets are
self-hosted (the CSP allows no font host), fingerprinted, and use metric adjustments plus
`font-display: swap` to avoid layout shift. Mobile's base `+1px` is a shell typography variable,
not another theme.

Inter is preloaded for the first paint. The other families are woff2 latin and latin-ext subsets
(`unicode-range`) with only the weights the UI uses: variable 400–700 for Geist, Geist Mono and
Work Sans, 500–700 for Fraunces, static 400/500/600/700 IBM Plex Mono and 400/700 Courier Prime.
They are declared once in `theme-fonts.css`, together with metric-matched `<Family> Fallback`
faces over local Arial, Courier New or Times New Roman. Browsers fetch a face only when rendered
text uses its family, and only a theme's tokens name these families, so Lounge downloads none of
them on the page (a Playwright test checks this; another checks that Terminal fetches only IBM
Plex Mono). Settings cards draw previews without text, so opening Settings loads no theme fonts.
The service worker still precaches every hashed asset, fonts included, after load and at low
priority, so a chosen theme keeps its fonts offline. Latin-subset bytes per theme: Modern 52 KB,
Terminal 60 KB, Retro 106 KB (latin-ext only when such characters appear).

## Network icons and brand assets

Remote `draft/ICON` images are content. They render unchanged with the theme's `iconRing`; failures
fall back to a themed letter tile. The first themed milestone always uses the light backing-plate
token where needed rather than inspecting image alpha.

Remote SVG stays an image resource and is never injected into the DOM. Fetch limits and caching
belong to a later image-security design. App brand assets come from the paths named in
`AGENTS.md` and may use approved light/dark variants.

## Accessibility

Validation checks the actual foreground/background, panel, selection, accent-control, error,
unread, mention-badge, and focus-ring pairs. Nick colours are checked on message and panel
surfaces; identity and unread severity are never conveyed by colour alone. Keyboard focus always
uses the explicit focus-ring token.

## Boundaries

This subsystem owns the theme-file schema, build validation, generated registry/CSS, system
resolution, previews, font declarations, nick palette mapping, icon presentation tokens, and
global semantic motion tokens. It does not own density, component markup, image fetching,
settings persistence, or capabilities.

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
