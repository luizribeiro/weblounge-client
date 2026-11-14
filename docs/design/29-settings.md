# 29 — Settings

Status: signed off by Luiz (2026-11-13). This is subsystem 16 of the brief ("Settings schema");
it takes the next free number, as 22 and 23 did. It does not reopen 22's "no settings sync".

## Problem

Things that need a user-visible switch are piling up: theme and density (implemented, but fixed
to their defaults), notifications and push, later "load previews and images from other
sites" (D5), per-network upload permission, a later per-channel "don't show media here", the
keyboard-shortcut help, sign-out, and per-network connection options. There is no Settings
surface. The desktop sidebar's no-op Settings button went on 2026-11-11, and its footer on
2026-11-12 (a signed-off departure from the prototype, design 09);
`settings.open` exists in the action registry only as an unavailable action. The phone has no tab
bar yet, so it has no Settings tab either.

Today's settings-like state is scattered:

| State | Where it lives now | Persisted |
|---|---|---|
| Theme | `installTheme` (`app/src/theme/theme-controller.ts`); `setPreference` has no caller | no; always follows the system |
| Message layout and densities | `densityDefaults` (`app/src/density/density.ts`), applied once at startup | no |
| Notification prompt dismissal | engine `notification_settings.rs`, `Space::Settings` key `notifications/prompt` | yes, engine-owned |
| Push subscription | engine push device state plus the browser permission | yes |
| Member-list visibility, pane tree | device-local UI persistence (design 09) | yes |
| Debug harness | build-time `WEBLOUNGE_IRC_*` and `/debug` | n/a |

## Source of truth for look and structure

Settings was designed in the original prototype ("weblounge Client Prototype",
<https://claude.ai/artifact/PXzq4fDvG8MuFsTCpmDhA9>, 2026-10-17), whose files are byte-identical
to `docs/reference/prototype/`:

- **Desktop:** `Main.dc.html`, the `settings` overlay (markup around lines 265–395; data in the
  `/* Settings */` block around lines 790–895). A modal of at most 820×660 with a title bar
  ("Settings", Close), a 188px section nav on `panelAlt` with icons (Appearance, Networks,
  Notifications), and a scrolling pane. Sections have small uppercase headers; a row is a label
  and one-line description on the left and a segmented control or switch on the right.
- **Phone:** `Mobile.dc.html`, the Settings tab (root list around lines 109–135, pushed pages
  around 150–260, data around 791–895). A large "Settings" title; root rows with an icon tile,
  the section name and its current value ("Lounge · one-line · cozy", "2 of 2 connected",
  "Mentions & DMs" or "Push off"); one pushed page per section with a Back header. Segmented
  controls sit full-width under their label on the phone.
- **Content** (both): Appearance → Theme (seven preview cards drawn from each theme's tokens);
  Conversation: Message layout, Message density, Avatars, Mode symbols, Joins/parts/quits;
  Sidebars (desktop: Sidebar density) or Chat list (phone: List density, "Compact hides message
  previews"). Networks → "Add network" and one card per network: icon, name, status dot and
  "Connected · software", Server messages and Disconnect/Connect, then fields (Server,
  Connection, Nickname, Account, Push, Features) and a "Connect automatically" switch.
  Notifications → This device: Push notifications, Notify me about (Everything / Mentions & DMs /
  Nothing; "Muted channels never notify"); Highlights: highlight-word chips, Mentions from bots.

This design builds exactly that, and extends it only where the prototype did not anticipate a
setting. Every extension is listed under Decisions.

## Information architecture

Every setting belongs to exactly one scope. The client is network-agnostic, so a scope is never
"weblounge"; it is "this network".

| Scope | Holds | Where the user changes it |
|---|---|---|
| **App** | Appearance and Notifications as in the prototype; version and diagnostics | Settings sections |
| **Network** | Connect automatically and Connect/Disconnect (prototype); the upload-host password permission and Sign out (new) | That network's card in Settings → Networks; also reached from ⌘K "Network settings", which opens the modal on Networks |
| **Conversation** | mute and "don't show media here" (later) | The conversation's own details: the desktop header menu and the phone's channel details sheet. Not in Settings |

Additions to the prototype's content:

- **Appearance:** a **System** card (Lounge by day, Lounge Night after dark), selected by default;
  design 08 already planned a visible "Match system" choice (D4). The cards run System, Lounge,
  Lounge Night, Black, Modern, Terminal, Retro. Each shows its theme's one-line description under
  the name (also its accessible description). The grid wraps at 104px per card on desktop (5 + 2
  in the 820px modal) and scrolls horizontally on the phone.
- **No remote-media switch yet (D5).** Link previews are paused and images from other sites never
  show, so there is nothing to switch. Media from a network's own upload host always loads. The
  "Previews and images from other sites" switch (off by default) returns with link previews.
- **Network card:** below Connect automatically, an "Uploads" row once the user has been asked:
  "Send your password to `<upload host>`" switch, revocable (D6). The card's button pair gains
  **Sign out** (D7).
- **A fourth section, About** (D8): version and build, "Keyboard shortcuts" (desktop; dispatches
  `shortcuts.open`), "Copy diagnostics" (the `/debug` lines), and "Sign out of everything", which
  clears the device (design 22). On the phone its root row's value is the version.

A row shows only where it has an effect: push rows only where the platform can push, Sidebar
density only on desktop, List density only on the phone, Keyboard shortcuts only with a keyboard
shell.

## Surfaces

### Desktop and web: the prototype's modal

As drawn, typed by design 10 as `Overlay { kind: "settingsModal"; page }`. Changes apply
immediately; there is no Save button. Below design 09's narrow-desktop breakpoint the modal fills
the window and uses the phone's root-list-then-page model inside it.

Entry points (D12):

- A Settings button in the sidebar header, beside the search button at the row's right edge, where
  design 09 says header buttons join it. The prototype's footer button does not return: the footer
  is gone. The two 32px buttons sit as one group so the brand text keeps the most room; at 224px
  the network summary line ellipsizes first, then the brand text; neither overlaps the buttons. The
  same header shows in the narrow-desktop drawer.
- The button draws a **gear**, not the prototype's sliders: sliders read as filters or adjust, a
  gear as Settings (Luiz, 2026-11-13). The same glyph marks Settings on the phone and in the
  palette, from one shared icon component, at the stroke weight and size of its neighbouring
  header icons.
- Its accessible name is "Settings", with `aria-haspopup="dialog"`, a tooltip naming the
  chord, and `aria-keyshortcuts` from the active binding. Hover uses `chip`; pressed uses
  `selection`; focus shows the focus ring.
- A "Settings" row in the ⌘K palette and command palette (`settings.open`).
- The `settings.open` chord: `⌘,` in the Mac app (its app-menu item, D3) and `Mod+Shift+,` (⇧⌘,)
  on the web, where browsers own `⌘,` (design 14). The page knows it runs in the Mac app from
  design 27's `globalThis.__WEBLOUNGE_SHELL__` (`kind: "macos-app"`).
- Closing returns focus to the element that opened Settings when it is still in the document,
  otherwise to the composer.

### Phone: the prototype's Settings tab

As drawn: root list, one pushed page per section with the standard push/pop motion and
swipe-back, and Networks → Server messages as the only second level (design 10's depth rule
holds). Settings is the third tab once the tab bar ships with Activity (design 10, milestone 5).
Until then a 44×44 Settings button (the gear) at the Chats header's trailing edge pushes the same
Settings root onto the Chats stack (D2).

### Tauri macOS

No native Settings window: every setting would need a second, native implementation. The
wrapper (design 27) gains an app-menu item, **Settings… ⌘,**, which runs a fixed script in the
page that dispatches `settings.open`. That is a one-way trigger, not IPC, so design 27's rule that
the remote origin sees no Tauri API holds. The later native Tauri shell builds the same menu item
from the action registry (design 14) and opens the same modal (D3).

**Page entry point.** The page listens on `window` for one event and runs the action it names:

```js
window.dispatchEvent(new CustomEvent("weblounge:action", { detail: "settings.open" }));
```

Only actions in the shell-menu allow-list (`app/src/actions/shell-actions.ts`) run this way:
`settings.open`, and `buffer.next` and `buffer.previous` for the Window menu's next and previous
conversation items. The registry's action ids are the public names. Any other detail is ignored,
and the phone shell, which has no app menu, acts only on `settings.open`. Each runs the same
registry action as its chord; `settings.open` is also the button's and the palette's, so it opens
Settings on whichever shell is showing, and drops the request while the app is
still starting: the shells install the listener when they mount, after the splash, so there is no
Settings to show before then. On the phone the event does nothing while Settings is already
showing.

In the Mac app the menu accelerator owns `⌘,`: the menu consumes the key before the web view sees
it. The page also binds `⌘,` there (selected by `__WEBLOUNGE_SHELL__`), so the chord works before
the menu item lands; opening Settings when it is already open does nothing, so the two can never
double-fire visibly.

## Engine/UI boundary and storage

The engine owns every persisted setting, as the brief requires ("validation of settings" is an
engine job) and as design 22 requires (the UI never writes a store). Settings live in
`Space::Settings`, device-local, never synced (D9). Every UI attached to the same engine (two tabs
on one SharedWorker) sees changes live.

- One record per scope: `settings/app`, `settings/network/<NetworkKey>`,
  `settings/conversation/<NetworkKey>/<BufferKey>`. Each is `{ version, fields }`.
- Missing fields decode to defaults, so adding a setting needs no migration. An invalid value for
  one field falls back to that field's default and is reported; it never discards the record.
- `NetworkKey` is design 23's stable per-network UUID (persisted in Durable; not yet in code) and
  `BufferKey` the casemapped buffer name, never the per-run numeric IDs. Per-network and
  per-conversation records therefore wait for `NetworkKey`; the first slice needs neither.
- Signing out of a network deletes its network and conversation records. "Sign out of
  everything" clears the whole profile, Settings included (design 22).
- The existing `notifications/prompt` record stays as is: it is device state, not a preference.
- Remembered upload approvals (design 31) are already in `Space::Settings`, under
  `uploads/approvals`, keyed by endpoint, account and file host because `NetworkKey` does not
  exist yet; unlike the per-scope records it is one record for the whole device. It is the data
  behind the network card's `UploadPassword` row. The Networks slice adds the request that lists
  it, and its switch uses `ForgetUploadApprovals`. When `NetworkKey` lands, the engine moves each
  approval into its network's `settings/network/<NetworkKey>` record on first read, and
  `ForgetUploadApprovals` clears it there.

**First paint.** Theme and density must be right before the engine answers, or each launch
flashes the default theme. The page keeps a non-authoritative copy of the resolved appearance
fields in `localStorage`, written only when the engine reports settings and read only until the
engine's first `SettingsLoaded` (D10). The engine value always wins. A small classic script in
the document head (same origin, so the CSP's `script-src 'self'` allows it) applies the copy to
`<html>` before the first paint, including the splash's light or dark look; the app then starts
from the same copy. Without a copy, or when storage is unavailable or holds anything that does not
validate, the copy is ignored and the theme follows the system as before.

Protocol (design 02):

```rust
enum EngineRequest { /* … */ LoadSettings, ChangeSetting { change: SettingChange } }
enum EngineEvent { /* … */ SettingsLoaded { settings: Settings }, SettingsChanged { settings: Settings } }
```

`SettingsChanged` carries the whole resolved snapshot; it is small, and one shape spares the UI
a patch merge.

## Types

Rust is the source; TypeScript is generated (as for the protocol). Each scope is a closed enum of
key-plus-value pairs, so an unknown key or a mistyped value cannot be constructed.

```rust
pub enum SettingChange {
    App(AppSetting),
    Network { network: NetworkKey, setting: NetworkSetting },
    Conversation { network: NetworkKey, buffer: BufferKey, setting: ConversationSetting },
}

pub enum AppSetting {
    Theme(ThemePreference),            // System, or one variant per shipped theme
    MessageLayout(MessageLayout),      // OneLine | Grouped
    MessageDensity(Density),           // Compact | Cozy | Comfortable
    DesktopListDensity(Density),
    MobileListDensity(Density),
    Avatars(bool),
    ModeSymbols(bool),
    MembershipEvents(bool),
    PushOnThisDevice(bool),
    NotifyAbout(Alert),                // All | MentionsAndDirect | Nothing (design 23)
    HighlightWords(HighlightWords),    // deduplicated, casemapped, non-empty words
    BotMentions(bool),
}

pub enum NetworkSetting {
    ConnectAutomatically(bool),
    UploadPassword(UploadPermission),
}

pub enum ConversationSetting {
    Media(MediaPolicy),                // Inherit | Hide; lands with D5's remote media
}

pub enum UploadPermission {
    NotAsked,
    Allowed { host: HttpsOrigin },     // a different host asks again
    Denied { host: HttpsOrigin },
}

pub struct Settings {                  // fully resolved: no Option in the UI's view
    pub app: AppSettings,
    pub networks: BTreeMap<NetworkKey, NetworkSettings>,
    pub conversations: BTreeMap<(NetworkKey, BufferKey), ConversationSettings>,
}
```

The prototype says Notify me about "applies to every network", so there are no per-network
notification overrides; muting stays with design 23's rules model. There is no generic cascade:
a lower scope overrides only what it declares (once it exists, conversation media). Effective values are
computed in the engine; the UI renders them.

Navigation uses a closed page union, matching the prototype's sections plus About:

```ts
export type SettingsPage =
  | { readonly section: "appearance" | "notifications" | "about" }
  | { readonly section: "networks"; readonly network?: NetworkKey }; // scrolls to that card
```

## Registering settings

`app/src/features/settings/` owns the modal, the phone pages and the row primitives drawn in the
prototype (`Switch`, `Segmented`, `ThemeCards`, `WordChips`, `NetworkCard`, `LinkRow`). A feature
contributes rows through its public `index.ts`; Settings never imports a feature's internals.

```ts
export interface SettingRow {
  readonly id: SettingRowId;
  readonly section: SettingsPage["section"];
  readonly group: MessageKey;                                   // "Conversation", "This device", …
  readonly title: MessageKey;
  readonly description?: MessageKey;
  readonly shownWhen: (context: SettingsContext) => boolean;    // platform, shell, capabilities
  readonly control: SettingControl;
}

export type SettingControl =
  | { readonly kind: "switch"; readonly read: (s: Settings) => boolean;
      readonly change: (on: boolean) => SettingChange }
  | { readonly kind: "choice"; readonly options: readonly ChoiceOption[];
      readonly read: (s: Settings) => ChoiceValue; readonly change: (v: ChoiceValue) => SettingChange }
  | { readonly kind: "action"; readonly action: ActionId }                // e.g. shortcuts.open
  | { readonly kind: "custom"; readonly component: SettingComponent };   // theme cards, chips
```

Network-card rows register the same way with `scope: "network"` and receive the card's
`NetworkKey`. Adding a setting is: one Rust variant with its default and validation, one row in the
owning feature, its strings, and tests. A test fails if a row's section is unknown or two rows
share an ID. The same registry can later feed ⌘K search over settings.

## Accessibility and native feel

- The modal is a `dialog` with `aria-modal`, a focus trap and a labelled title. Esc
  (`navigation.escape`) closes it and returns focus to the invoker, then the composer (design 15).
- The section nav marks its current item `aria-current="page"` (as drawn); arrow keys move
  within it. Switches are `role="switch"`. Segmented controls become a `radiogroup` with arrow
  keys rather than the prototype's `aria-pressed` buttons, so a screen reader hears one choice.
- Labels, descriptions and section headers are chrome and not selectable (brief §2); values the
  user may copy (server, account, version, diagnostics) are.
- Phone rows are at least 44pt; switches are 50×30 as drawn. Pushed pages use the shared motion
  and swipe-back; reduced motion commits immediately.
- Theme cards are drawn from each theme's tokens (design 08): colours and the control radius.
  Unlike the prototype, the card label stays in the app's UI font, so opening Settings downloads
  no other theme's fonts. A theme change applies live under the open modal.
- Destructive actions (Sign out, Sign out of everything, revoking upload permission) go through
  the `confirmation` overlay (design 10).
- Text scales with Dynamic Type and browser zoom; descriptions wrap rather than truncate.

## Decisions (signed off 2026-11-13)

| ID | Question | Decision |
|---|---|---|
| D1 | Follow the prototype's modal (desktop) and Settings tab (phone) as drawn | Yes |
| D2 | Phone entry before Activity exists | A 44×44 gear button at the Chats header's trailing edge pushes Settings onto the Chats stack; Settings becomes a tab with Activity |
| D3 | macOS app | Same in-page modal via a "Settings… ⌘," menu item that dispatches the `weblounge:action` page event; no native window |
| D4 | Theme default | Add a "System" card, selected by default |
| D5 | Remote media | **Changed:** no switch for now; link previews are paused and images from other sites never show |
| D6 | Upload password permission | Ask at first upload; remember per network and host; a row in the network card |
| D7 | Per-network sign-out | A Sign out button in the network card |
| D8 | Where keyboard help, version, diagnostics, sign-out-of-everything go | A fourth section, About |
| D9 | Sync | Device-only for now |
| D10 | First-paint appearance | `localStorage` paint hint written only from engine values, applied by a head script before the first paint |
| D11 | Per-conversation settings | In the conversation's details, not in Settings |
| D12 | Desktop entry button | A gear button in the sidebar header grouped with search at the right edge, drawing a gear rather than the prototype's sliders, plus the ⌘K "Settings" row and the chord (⌘, in the Mac app, ⇧⌘, on the web) |

## Out of scope

Settings sync and server-side notification rules (design 23's deferred proposal); per-network
notification overrides; keyboard rebinding; quiet hours and per-sender rules; settings search;
import/export; onboarding (Add network still opens it, design 18); a native macOS Settings window;
link previews themselves and their switch (D5).

## Testing

- Rust: decoding defaults, missing and unknown fields, invalid-field fallback, record versions,
  scope keys, sign-out deletion, `HighlightWords` and `HttpsOrigin` validation, and that a
  `ChangeSetting` persists before `SettingsChanged` is emitted.
- Protocol round-trip of `SettingChange` and `Settings` through the generated TypeScript types.
- TypeScript: registry integrity (unique IDs, known sections, `shownWhen` per platform), each
  control's read/change pair, the paint-hint mirror (written only from engine events, ignored once
  loaded), and the settings page reducer.
- TypeScript: the chord resolves to `⌘,` when `__WEBLOUNGE_SHELL__.kind` is `"macos-app"` and to
  `⇧⌘,` otherwise; the `weblounge:action` listener runs `settings.open` and ignores other details.
- Playwright (Chromium and iPhone WebKit): open Settings from the header gear (tooltip and
  `aria-keyshortcuts` present), the palette, the chord and the page event; change theme and density
  and see the conversation change; reload and assert the theme of the first animation frame (before
  the first paint), so the head script is covered; a second tab follows the change live; the phone
  path pushes and pops with Back and swipe; focus returns to the invoker, then the composer;
  screenshots compared with the mockup; `nativeFeelAudit` and its idle/hidden checks stay green.

## First slice

Appearance only, end to end, on both shells:

1. Engine: `AppSettings` with `Theme` and `MessageDensity`, the `settings/app` record,
   `LoadSettings` / `ChangeSetting` / `SettingsLoaded` / `SettingsChanged`, with tests.
2. UI: `installTheme` and `installDensity` driven by the engine snapshot, plus the paint hint.
3. Desktop: the prototype's modal with only Appearance in its nav, showing Theme (System plus the
   two shipped themes) and Message density; the sidebar-header gear, `settings.open` made
   available, and the web chord.
4. Phone: the Chats-header gear, the Settings root list with Appearance, and its pushed page.
5. Playwright journeys for desktop and phone as above.

Then the rest of Appearance, Notifications, Networks and About, one slice each with its rows and
tests. The macOS wrapper's menu item lands with step 3.
