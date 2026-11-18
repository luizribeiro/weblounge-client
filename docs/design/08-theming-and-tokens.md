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

In picker order: Lounge, Lounge Night, Black, Modern, Terminal, Retro, Monokai, Earthsong, n.e. Lounge
Night and Lounge are the System pair. Modern, Terminal and Retro take the prototype's `THEMES`
values; tokens the prototype lacks follow each theme's own family (focus ring = accent, mention
badge = the unread or error red). Black is Lounge Night for OLED screens: `#000` for the app,
surfaces and panels, near-black only where layering needs it (`#0a0a0a` inputs and code, `#111`
chips and panel borders, `#1a1f1c` content borders and `#1a241d` selection), and Lounge Night's
accent and text colours, which already pass on black (fg 18.1:1, muted 9.7:1, accent 13.7:1, unread
10.1:1). Monokai takes its colours from Luiz's own WezTerm scheme `Custom Monokai`, named after
Wimer Hazenberg's Monokai; its values match none of Monokai Classic, Remastered, Soda, Vivid,
SublimeText, Dimmed or Monokai Pro in mbadolato/iTerm2-Color-Schemes, so no third-party palette file
or licence applies. It uses `#1c1c1c` app and surfaces, a darker `#161616` sidebar for separation,
`#262621` (ANSI black) for inputs, code and panel borders, `#383731` (selection) for selection and
content borders, `#f8f7f2` text and `#fefefe` selected text. The accent, focus ring and online dot
are the green `#bbd756`, the self nick the yellow `#ded685`. Where an ANSI colour falls short on
`#1c1c1c` it is lightened just enough: muted `#717171` (3.5:1) to `#8e8e8e` (5.2:1, and 4.6:1 for
the composer placeholder on `#262621`), the pink `#cf5a78` (4.4:1) to `#d4607d` (4.7:1) for the
unread dot and mention badge, the red `#ca4238` (3.5:1) to `#d65e4f` (4.5:1) for errors, and the
purple `#7b72c2` (4.1:1) to `#8a81d2` (5.0:1) in the nick palette (green, yellow, cyan, purple, pink
and the classic Monokai orange `#fd971f`, since the scheme has no orange and its red reads as an
error). It is set in Hack at Terminal's 13px with 3px corners, a touch softer than Terminal's 2px to
match Hack's rounder forms. Earthsong is the Earthsong terminal scheme as published in
mbadolato/iTerm2-Color-Schemes (`windowsterminal/Earthsong.json`, MIT): `#292520` app and surfaces,
a darker `#211e1a` sidebar, `#121418` (ANSI black and the scheme's selection) for inputs, code and
panel borders, `#e5c7a9` sand text and `#f6f7ec` (bright white) selected text. The scheme's
near-black selection would vanish on the darker sidebar, so selection and content borders use a
lifted brown `#403830`. The accent, focus ring and online dot are the green `#85c54c` (7.3:1), the
self nick the amber `#f5ae2e`, the mention background an amber tint `#3a2f1f`. Lightened just enough
on `#292520`: muted `#675f54` (2.4:1) to `#9a8f81` (4.8:1, 5.8:1 for the placeholder on `#121418`),
the orange `#d0633d` (4.0:1, the scheme's magenta slot) to `#db6d46` (4.6:1) for the unread dot and
mention badge, and the red `#c94234` (3.1:1) to `#e4664f` (4.6:1) for errors. The nick palette takes
six distinct hues: green, amber, blue `#1398b9` (4.5:1), bright salmon `#ff9269`, bright blue
`#5fdaff` and bright yellow `#e0d561`. Red stays out, as it reads as an error, and the cyan
`#509552` too, as it is a second green beside `#85c54c`. Like Monokai it is a terminal scheme, so it
shares Monokai's Hack, 13px and 3px corners. n.e. (id `ne`) takes the dark palette of pgray.dev
and neutral.engineering, whose stylesheets share one `:root.dark` block; it is named after the
neutral.engineering wordmark, so no person's name brands it. Exact site values: `#111111` (`--bg`)
for the app, surfaces and panels, `#e5e5e5` (`--fg`) text, `#999999` (`--muted`) muted text and
the redaction bar, `#333333` (`--border`) for every border, and `#fcc21b` (`--yellow`) for the
accent, focus ring and self nick, with `#111111` on it, as the sites' `mark` and active nav link
set it. The text selection is that `mark` pair. The sites use one hue, so the theme does too: no
other hue appears anywhere. Roles the sites lack are derived from those values: `#000000` inputs
and code (black under the `#111` page), `#1a1a1a` hovered rows, `#222222` chips, `#262626` the
selected row with `#e5e5e5` text, and `#282312` (`#fcc21b` at 10% over `#111`) the mention
background. Unread, the mention badge, the online dot and errors are the same yellow; their
meaning comes from their place and shape, never colour alone. Luiz decided errors stay yellow
rather than take a muted red. The nick palette varies the yellow
and the greys in lightness: cream `#fff0b3`, light yellow `#ffd966`, gold `#d9a514`, khaki
`#a68a3c` (5.7:1), light grey `#cccccc` and grey `#8f8f8f` (5.8:1). Some nicks are harder to
tell apart than in other themes; Luiz accepted that as part of the theme. Every site colour passes
its contract on `#111` unchanged (fg 15.0:1, muted 6.6:1, yellow 11.6:1, `mark` 11.6:1). It is set
in IBM Plex Mono, the sites' face, at Terminal's 13px, with the sites' square corners (0px) and no
shadows. pgray.dev also lays a time-of-day 2000 K multiply overlay (`#ffa03e`) over the page, on by
default, which warms it towards orange. Luiz decided the theme stays yellow: it takes the sites'
stylesheet colours, not that filter. A unit test checks text pairs at 4.5:1 and indicators
at 3:1 in every theme.

## Text selection

Selected text has its own pair, `textSelection` / `textSelectionFg`
(`--wl-color-text-selection[-fg]`), separate from `selection` / `selectionFg`, which mark the
selected row in lists (sidebar, switcher, settings nav). A row selection must stay quiet beside its
neighbours; a text selection must stand out from everything around it, so one pair can't do both.
`::selection` in `base.css` uses the pair everywhere: transcript text, the topic, the composer and
native inputs where the platform honours `::selection`. The transcript's nick and time, which the
copy handler paints when a selection spans rows (F43), use the same pair, so a selected nick drops
its palette colour for `textSelectionFg`.

Each theme takes the pair from its own palette, inverting it so the selection reads against the
surface: dark themes use a bright palette colour with their background or surface as text, light themes their
dark ink or accent with a light text colour.

| Theme        | Background | Text      | Ratio  |
| ------------ | ---------- | --------- | ------ |
| Lounge       | `#1d2825`  | `#bdd9a7` | 9.9:1  |
| Lounge Night | `#bdd9a7`  | `#18221e` | 10.6:1 |
| Black        | `#bdd9a7`  | `#000000` | 13.7:1 |
| Modern       | `#1a3bb0`  | `#ffffff` | 9.1:1  |
| Terminal     | `#e6b450`  | `#121314` | 9.8:1  |
| Retro        | `#4a3527`  | `#fff3dc` | 10.4:1 |
| Monokai      | `#ded685`  | `#1c1c1c` | 11.4:1 |
| Earthsong    | `#f5ae2e`  | `#292520` | 8.0:1  |
| n.e.         | `#fcc21b`  | `#111111` | 11.6:1 |

The contrast test requires 7:1 (WCAG AAA) for the pair, and 4.5:1 between the selection background
and each row background (`bg`, `surface`, `panelAlt` for hovered rows, `mentionBg` for highlights),
so a selection reads on every row it can cover.

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

A word in message text is a mention when the buffer knows that nick: a current or former channel
member, an author or membership-event nick in the loaded timeline, the DM peer, or the user. The
engine attaches each message's mentions (`MessageProjection.mentions`) when it emits the timeline,
so a member list arriving after history recolours earlier rows. The known set only grows: a mention
stays coloured after that person leaves, because a transcript should not change colour under the
reader when someone parts. Words that were never a nick in the buffer stay plain text.

## Picker previews and fonts

The generated registry exposes a small preview token subset from each file. Settings renders DOM
preview cards from those tokens, not screenshots or nested apps. The decorative mini-layout is
`aria-hidden`; the control uses the theme's `name` as its label.

Fonts follow the brief: Inter, the system monospace stack, Geist/Geist Mono, IBM Plex Mono, Work
Sans, Fraunces, Courier Prime, and Hack. The named bundled families use SIL OFL licensing, except
Hack (MIT plus the Bitstream Vera licence), and may be redistributed; the licences sit next to the
files in `app/src/assets/fonts/`. Assets are self-hosted (the CSP allows no font host),
fingerprinted, and use metric adjustments plus `font-display: swap` to avoid layout shift. Mobile's
base `+1px` is a shell typography variable, not another theme.

Inter is preloaded for the first paint. The other families are woff2 latin and latin-ext subsets
(`unicode-range`) with only the weights the UI uses: variable 400–700 for Geist, Geist Mono and Work
Sans, 500–700 for Fraunces, static 400/500/600/700 IBM Plex Mono, 400/700 Courier Prime and 400/700
Hack, upright and italic (italic sets `/me` lines and notices). Hack is upstream v3.003, subset with
its hinting kept. They are declared once in `theme-fonts.css`, together with metric-matched
`<Family> Fallback` faces over local Arial, Courier New or Times New Roman. Browsers fetch a face
only when rendered text uses its family, and only a theme's tokens name these families, so Lounge
downloads none of them on the page (a Playwright test checks this; others check that Terminal
and n.e. fetch only IBM Plex Mono, and Monokai and Earthsong only Hack). Settings cards draw previews
without text, so opening Settings loads no theme fonts. The service worker still precaches every
hashed asset, fonts included, after load and at low priority, so a chosen theme keeps its fonts
offline. Latin-subset bytes per theme: Modern 52 KB, Terminal 60 KB, Retro 106 KB, Monokai and
Earthsong 47 KB upright plus 51 KB italic (latin-ext and italic only when such characters or text
appear).

## Network icons and brand assets

Remote `draft/ICON` images are content. They render unchanged with the theme's `iconRing`; failures
fall back to a themed letter tile. The first themed milestone always uses the light backing-plate
token where needed rather than inspecting image alpha.

Remote SVG stays an image resource and is never injected into the DOM. Fetch limits and caching
belong to a later image-security design. App brand assets come from the paths named in `AGENTS.md`
and may use approved light/dark variants. The favicon's attention tiles (design 23, Badging) are
brand colours, not theme tokens, since a tab icon cannot follow the theme: felt `#1B2A22` with the
paper chair at rest, `signal` `#E3B778` (from the brand `tokens.css`) with the ink chair for unread,
Lounge's `mentionBadge` `#9A3B2E` with the paper chair for mentions, and grey `#8C8F87` while not
connected.

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
