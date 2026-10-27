# 14 — Commands and shortcuts

Status: proposed for milestone 1 review.

## Problem

Every app action needs one typed identity and one availability rule. Keyboard shortcuts, the
switcher, help, buttons, tooltips, Tauri menus, slash commands, and later context menus are views
of that registry; none may invent an action ID, label, or binding. Defaults must work in both a
browser and Tauri without corrupting text entry or assuming a US keyboard.

This subsystem routes UI intent. Engine commands remain the Rust-owned protocol in subsystem 02,
and capability evidence remains the action projections in subsystem 17.

## Registry types

```ts
export type Platform = "macos" | "linux" | "windows" | "ios" | "android";
export type Shell = "web" | "tauri";
export type CommandScope =
  | "global" | "desktop" | "mobile" | "sidebar" | "messageList"
  | "messageNavigation" | "composer" | "switcher" | "list" | "settings"
  | "paneLayout" | "separator" | "onboarding" | "help";

export interface CommandSpec<I extends CommandId> {
  readonly id: I;
  readonly title: MessageKey;
  readonly group: CommandGroup;
  readonly scope: CommandScope;
  readonly slash?: SlashDescriptor;
  readonly menu?: MenuPlacement;
  readonly availability: (context: CommandContext) => CommandAvailability<I>;
  readonly handler: (command: AvailableCommand<I>, services: CommandServices) => Promise<void>;
}

export type CommandAvailability<I extends CommandId> =
  | { readonly state: "available"; readonly args: CommandArgs[I] }
  | { readonly state: "unavailable"; readonly reason: UnavailableReason };

export type AvailableCommand<I extends CommandId> = {
  readonly id: I;
  readonly args: CommandArgs[I];
};
```

`CommandId` and `CommandArgs` are closed generated unions checked exhaustively. Views call
`t(spec.title)`; the registry stores no English display string. Availability returns the typed
arguments needed by the handler, so a handler cannot run without a resolved current action.
Capability-gated commands resolve from `NetworkActions`, `BufferActions`, or `MessageActions` in
17. Pane commands resolve from the focused leaf plus `paneInDirection` or `nearestDivider` in 09.
The handler dispatches either a UI reducer action or an engine command from 02 and revalidates at
that boundary. Unavailable commands are absent from shortcuts, switcher, menus, and controls; a
command that becomes unavailable while a menu is open closes safely without dispatch.

```ts
export type Modifier = "Control" | "Alt" | "Shift" | "Meta" | "Mod";
export type KeyMatch =
  | { readonly kind: "key"; readonly value: string }
  | { readonly kind: "code"; readonly value: KeyboardEventCode };

export interface KeyChord {
  readonly modifiers: readonly Modifier[];
  readonly match: KeyMatch;
  readonly input: "never" | "nonText" | "emptyComposer" | "always";
  readonly repeat: "allow" | "deny";
}

export interface KeyBinding {
  readonly command: CommandId;
  readonly sequence: readonly [KeyChord, KeyChord?];
  readonly platforms: readonly Platform[];
  readonly shells: readonly Shell[];
  readonly scopes: readonly CommandScope[];
  readonly when?: BindingCondition;
}
```

`Mod` resolves to Command on Apple platforms and Control elsewhere. A sequence has at most two
steps and times out after 1,000ms; `Escape`, focus change, composition start, or an unmatched key
cancels it without consuming the unmatched key. Conditions are a closed data union such as
`desktop`, `multiplePanes`, `emptyComposer`, `selectedMessage`, and `focusedSeparator`, never an
arbitrary callback.

## Scope and resolution

The active stack, outermost first, is `global → shell → region → focused widget → mode → overlay`.
Each open overlay adds its own region/widget/mode scopes; the top overlay is innermost. The event's
composed path identifies the focused widget, rather than a duplicated global focus flag.

Resolution processes the stack inward-to-outward, then user bindings before defaults, then the
longest matching sequence. A chord may resolve to only one available command at a given scope and
platform/shell. Equal candidates are a registry error, not an order-dependent winner. A match
calls `preventDefault()` and `stopPropagation()` before dispatch. Unavailable bindings are skipped
so an outer valid binding may win.

`navigation.escape` is the sole Escape cascade: dismiss the top overlay, cancel message/placement
mode, mark the focused buffer read when the message list owns focus, then focus the composer. A
second Escape in the composer does nothing. Overlay close restores its invoker; roving-tabindex
lists retain their active item; keyboard focus always has a tokenized `:focus-visible` ring.

## Matching and typing safety

- Listen to `keydown`. Reject `isComposing`, legacy `keyCode === 229`, `key === "Dead"`, and
  `key === "Process"`. Completion and send let the composer's composition handlers finish first.
- `event.key` is the default. Printable letters are Unicode-case-folded; punctuation uses the
  produced character, so AZERTY and Dvorak users press the character shown, not a US position.
- `event.code` is used only by bindings marked `code`: native buffer slots, `Alt+A`, and every
  macOS Option-plus-printable default (letter, digit, or punctuation), because Option can turn the
  intended key into `å`, `¡`, or another character. Arrows and named keys still use `event.key`.
- Never treat `Ctrl+Alt` as a shortcut when `getModifierState("AltGraph")` is true. This preserves
  characters entered with AltGr on Windows and Linux.
- `input: "never"` excludes `input`, `textarea`, `select`, contenteditable, ARIA textbox, and the
  composer. `nonText` admits modified app commands but excludes plain keys and OS/readline editing
  chords. `emptyComposer` additionally requires no text, selection, completion, or composition.
- Plain `?`, `G`, `J/K`, `R`, `E`, and Delete run only in their explicit non-text/mode scopes.
  macOS readline chords (`Ctrl+A/E/K/N/P`) and word movement (`Alt+Left/Right`) are never captured
  in text. `Ctrl+N/P` is an extra only inside the switcher/list widget.
- Repeats are allowed only for list/message motion, page scrolling, and pane resizing. Destructive,
  overlay, split, send, and navigation commands deny repeats.
- A printable key in the message list focuses the composer and then inserts through normal input;
  it is not prevented or replayed synthetically.

## Default keymap

The macOS and Linux/Windows columns are Tauri desktop defaults. “same” means the web build uses
that binding too; an explicit web value replaces a native shortcut the browser owns. Contextual
keys work in every shell. `G then n` is a sequence outside text fields.

| Command ID — action | macOS | Linux / Windows | Web fallback or context |
|---|---|---|---|
| `switcher.open` — Jump to | `⌘K` | `Ctrl+K` | same |
| `shortcuts.open` — shortcut help | `?`, `⌘/` | `?`, `Ctrl+/` | same |
| `settings.open` — settings | `⌘,` | `Ctrl+,` | same; verify Safari/Firefox interception |
| `navigation.escape` — close/cancel/focus composer | `Esc` | `Esc` | scope cascade above |
| `navigation.back` / `navigation.forward` | `⌘[` / `⌘]` | `Alt+Left` / `Alt+Right` | `G then [` / `G then ]` |
| `search.open` — search current surface | `⌘F` | `Ctrl+F` | same; app search replaces find-in-page |
| `buffer.open` — join channel/start DM | `⇧⌘K` | `Ctrl+Shift+K` | same |
| `buffer.previous` / `buffer.next` | `⌥Up` / `⌥Down` | `Alt+Up` / `Alt+Down` | same; never in text |
| `buffer.previous-unread` / `buffer.next-unread` | `⌥⇧Up` / `⌥⇧Down` | `Alt+Shift+Up` / `Alt+Shift+Down` | same; never in text |
| `buffer.jump-important` | `⌥A` (`KeyA`) | `Alt+A` | same; never in text |
| `buffer.jump-1` … `buffer.jump-9` | `⌘1` … `⌘9` | `Ctrl+1` … `Ctrl+9` | `G then 1` … `G then 9` |
| `buffer.mark-read` | `Esc` in message list | `Esc` in message list | via `navigation.escape` |
| `buffer.mark-all-read` | `⇧Esc` | `Shift+Esc` | same |
| `buffer.load-older` | `⌥PgUp` | `Alt+PgUp` | same; also at history boundary |
| `pane.focus` — focus entered pane | focus/press pane | focus/press pane | pointer or Tab, no global chord |
| `pane.show-buffer` — show selected here | `Return` | `Enter` | sidebar/switcher selected scope |
| `pane.open-buffer-right` — open selected beside | `⌘Return` | `Ctrl+Enter` | sidebar/switcher; same |
| `pane.split-right` / `pane.split-down` | `⌘\` / `⇧⌘\` | `Ctrl+\` / `Ctrl+Shift+\` | same |
| `pane.focus-left/right/up/down` | `⌥⌘` + arrow | `Ctrl+Alt` + arrow | same; see accessibility conflicts |
| `pane.move-left/right/up/down` | `⌥⇧⌘` + arrow | `Ctrl+Alt+Shift` + arrow | same |
| `pane.grow` / `pane.shrink` | `⌥⌘=` / `⌥⌘-` | `Ctrl+Alt+=` / `Ctrl+Alt+-` | same |
| `pane.toggle-zoom` | `⇧⌘Return` | `Ctrl+Shift+Enter` | same |
| `pane.close` | `⌘W` | `Ctrl+W` | `⌥⌘W` / `Ctrl+Alt+W` |
| `sidebar.toggle` | `⌘B` | `Ctrl+B` | `⌥⌘B` / `Ctrl+Alt+B` |
| `members.toggle` | `⇧⌘M` | `Ctrl+Shift+M` | same |
| `message.page-up` / `message.page-down` | `PgUp` / `PgDn` | `PgUp` / `PgDn` | same, including composer |
| `message.jump-new` / `message.jump-bottom` | `⌥N` / `⌥End` | `Alt+N` / `Alt+End` | same; never in text |
| `message.select-last` | `Up` in empty composer | `Up` in empty composer | same |
| `message.previous` / `message.next` | `Up` / `Down`, `K` / `J` | `Up` / `Down`, `K` / `J` | message-navigation mode |
| `message.reply` | `R` | `R` | selected message; requires reply action |
| `message.react` | `E` | `E` | selected message; requires reaction action |
| `message.copy` | `⌘C` | `Ctrl+C` | selected message; DOM selection wins first |
| `message.redact` | `Delete` | `Delete` | selected message; confirmation + redact action |
| `composer.send` / `composer.newline` | `Return` / `⇧Return` | `Enter` / `Shift+Enter` | composer only |
| `composer.complete-next` / `composer.complete-previous` | `Tab` / `⇧Tab` | `Tab` / `Shift+Tab` | completion open; otherwise focus moves |
| `composer.history-previous` / `composer.history-next` | `⌘Up` / `⌘Down` | `Ctrl+Up` / `Ctrl+Down` | composer only |
| `list.previous` / `list.next` | `Up` / `Down`; `Ctrl+P/N` | `Up` / `Down` | roving list/switcher only |
| `list.open` / `list.open-beside` | `Return` / `⌘Return` | `Enter` / `Ctrl+Enter` | scoped aliases of pane show/open |
| `separator.decrease` / `separator.increase` | arrow; `⇧` = 10× | arrow; `Shift` = 10× | focused separator, ARIA orientation |
| `mobile.tab-chats/activity/settings` | `⌘1/2/3` | `Ctrl+1/2/3` | Tauri mobile hardware keyboard only |
| `network.connect` / `network.disconnect` | `Return` | `Enter` | focused settings control or switcher |
| `network.open-server` | `Return` | `Enter` | focused network row or switcher |
| `network.add` / `network.remove` / `channel.part` | `Return` | `Enter` | focused control or switcher; destructive confirmation |
| `network.import-bouncer` / `push.configure` | `Return` | `Enter` | focused control/switcher when projected by 17 |
| `message.retry` | `Return` | `Enter` | focused failed-message control or switcher |
| `activity.mark-all-read` | `⇧Esc` | `Shift+Esc` | Activity scope; same engine action |

Slash-command entries share IDs where semantics match (`/join` → `buffer.open`) and otherwise use
their engine parser descriptor. They are shown in the switcher but do not receive global chords.
Controls without a bespoke global chord remain reachable by Tab plus Enter/Space and appear in the
switcher when their action exists; contextual activation is their documented web route.

## Conflict analysis

The checked references are Apple HIG/Safari/VoiceOver, Chrome and Firefox shortcut lists, Windows
accessibility shortcuts, GNOME/KDE defaults, and the NVDA guide. Browser/desktop customizations can
still change them, so the compatibility matrix is an executable fixture, not a permanent claim.

| Defaults | Known conflict and disposition |
|---|---|
| `Mod+K`, `Mod+,`, `Mod+/`, `Mod+F`, `Mod+B` | Browsers use some for omnibox, settings/help, find, or bookmarks; preventable page handling varies. Search intentionally replaces find. Sidebar gets the safer web `Mod+Alt+B`; settings remains **verify in Playwright/manual** on Safari/Firefox. |
| native `Mod+1…9` | Chrome, Firefox, and Safari select browser tabs. Never registered on web; `G then digit` has no host chord. macOS `Shift+Command+3/4` screenshots are therefore also avoided. |
| native `Mod+[` / `Mod+]` | Safari history; Linux/Windows `Alt+Left/Right` browser/OS history. Web uses sequences. Settings/mobile Back uses its scoped command rather than stealing text navigation. |
| native `Mod+W` | Closes a browser tab/window and is intentionally Tauri-only. Web `Mod+Alt+W` is not listed by major browsers; **verify KDE/global custom shortcuts manually**. |
| `Alt+Up/Down`, `Alt+Shift+Up/Down`, `Alt+A/N/End/PgUp` | macOS text paragraph movement and Windows/NVDA sentence movement matter in editable/read modes, so all are suppressed in text. Firefox Linux owns `Alt+1…9`, not these. GNOME may expose mnemonic menus on Alt; **verify installed-app webviews manually**. |
| `Mod+Alt+arrows` and shifted move variants | VoiceOver's default modifier is Control+Option and Windows Magnifier pans with Ctrl+Alt+arrows; these users may not receive pane chords. Every pane command remains in switcher and focused controls/placement dialog. Test VoiceOver/NVDA; do not override assistive technology. KDE uses Meta+Alt+arrows, not this default, but is configurable. |
| `Mod+Alt+=/-` | macOS uses Option+Command+=/- for accessibility zoom and Windows Magnifier uses Ctrl+Alt+minus in some modes. Divider arrows and switcher commands are the accessible fallback. **Verify while magnification is enabled.** |
| `Mod+\`, `Mod+Shift+\`, `Mod+Shift+M/K/Enter` | Safari uses Shift+Command+backslash for tab overview, and Firefox/Chrome may use some shifted chords in developer UI. Test browser delivery; user overrides can disable a loser. Split commands remain in pane controls/switcher. |
| `PgUp/PgDn`, arrows, Tab, Enter, Escape, Delete | Native editing, browser scrolling, and NVDA browse mode use these. They run only in an owning widget/mode; real controls keep native semantics. NVDA browse mode may consume single letters/arrows, so keyboard-only E2E includes focus mode and all actions remain exposed as buttons. |
| `?`, `G`, `J/K`, `R`, `E` | VoiceOver Quick Nav and NVDA browse-mode single-letter navigation can consume them. They never fire in text and are convenience bindings only; `Mod+/`, lists, buttons, and switcher are the non-single-key routes. |
| `Ctrl+P/N` | macOS readline previous/next and browser print/new-window conventions. Registered only inside the open list widget; never in composer or ordinary inputs. Arrow alternatives are primary. |
| `Shift+Escape` | Chrome Task Manager is `Shift+Esc` on Windows/Linux and may be host-reserved. Mark-all-read remains in switcher and Activity control; **verify whether Chromium/Tauri delivers it** before shipping. |

Defaults do not use `Mod+T/N/Q`, `Ctrl+Tab`, `Ctrl+Shift+T/N`, `Alt+F4`, or system Meta/Super
shortcuts. User overrides may request them in Tauri but validation rejects them for web.

## Help and binding presentation

`shortcuts.open` opens a modal generated from available registry entries. It groups Global,
Navigation, Panes, Messages, Composer, Lists, and Settings; search matches localized title,
command ID, and rendered chord. Results update while typing, use a roving list, and close through
`navigation.escape`, restoring the invoker. `?`, `Mod+/`, a “Keyboard shortcuts” switcher row, and
the Settings link all dispatch the same command.

The formatter uses the current platform and active shell. macOS modifier glyphs always render in
Apple HIG order `⌃⌥⇧⌘` (correcting the addendum's `⌘⌥⇧⌃` example), omits `+`, and localizes key
names. Other platforms render `Ctrl+Alt+Shift+K`. Sequences read “G then 3”. `aria-keyshortcuts`
uses WAI-ARIA tokens such as `Control+K`, never glyphs; two-step sequences are described in the
accessible name because ARIA has no sequence syntax.

Command rows in the switcher, button tooltips, help, and menus ask the same resolver for the first
active binding. No component contains shortcut prose. Tooltips append the visual label; controls
set `aria-keyshortcuts` only for a single chord that is active in that context.

## Tauri menus and mobile hardware keyboards

The Tauri adapter filters available registry commands for platform `macos|linux|windows`, shell
`tauri`, and menu metadata, then emits localized menu items and native accelerators from the same
single-chord bindings. Sequences and contextual plain keys are not menu accelerators. A menu event
dispatches its command ID back through availability resolution; capability/layout updates rebuild
or disable affected menu items in one batch. macOS uses standard Application/Edit/View/Window/Help
placement; Close Pane owns `Mod+W`, Settings owns `Command+,`, and ordinary copy/paste stay native.

iPad and Android hardware keyboards first receive DOM bindings in the Tauri webview, with `Mod`
mapped to Command on iPadOS and Control on Android. UIKit `UIKeyCommand` can mirror stable global
single chords and their localized discoverability titles into the Command-hold HUD, but Tauri 2
needs a small native plugin and responder-chain validation; sequences and capability-dynamic
commands are unlikely HUD candidates. Android has no equivalent system HUD, so the in-app help is
authoritative. This is feasibility only; packaging design 19 decides the native bridge.

## User overrides

```ts
export interface KeymapOverridesV1 {
  readonly version: 1;
  readonly commands: Readonly<Partial<Record<CommandId, OverrideEntry>>>;
}
export type OverrideEntry =
  | { readonly kind: "disabled" }
  | { readonly kind: "replace"; readonly bindings: readonly UserBinding[] }
  | { readonly kind: "add"; readonly bindings: readonly UserBinding[] };
```

This device-local data layer is decoded, normalized, and conflict-checked before use. Invalid or
future-version data is preserved but ignored with diagnostics. Overrides cannot add handlers,
titles, command IDs, availability rules, shell-reserved web chords, or `always` input policy.
There is no editing UI in this milestone.

## Testing

- Unit tests build every platform × shell registry, reject equal-scope conflicts and reserved web
  chords, and require every available command to have a web route or documented focused-control
  route. A golden lists resolved/display/ARIA labels.
- Event fixtures cover macOS/Windows/Linux modifiers, AltGraph, repeat, dead keys, composition and
  `keyCode 229`, editable/contenteditable/ARIA textbox guards, empty composer, and Escape priority.
- AZERTY and Dvorak fixtures prove letter/symbol `event.key` matching; macOS Option-letter/digit
  and slot fixtures prove deliberate `event.code` matching without leaking to AltGr.
- Registry tests project each 17 action and each 09 layout query, then remove it and prove the
  shortcut, switcher row, menu, help row, tooltip, and ARIA value disappear together.
- Playwright drives only the keyboard to switch buffers, use `G then digit`, mark read, open/help
  search/close overlays, select/reply/react/copy a message, split/focus/move/resize/zoom/close panes,
  operate separators, and navigate settings in Chromium, Firefox, and WebKit.
- Manual release checks cover Safari native interception, Chrome/Firefox on three desktop OSes,
  GNOME/KDE custom defaults, Windows Magnifier, VoiceOver Quick Nav, NVDA browse/focus modes, and
  iPad/Android hardware keyboards. Unverified rows above remain test-plan items.

## Boundaries and out of scope

This subsystem owns command identity, localization keys, availability wiring, binding data,
resolution, display, help, override decoding, and menu generation. It does not own engine action
semantics, pane geometry, focus-widget implementation, slash parsing, context-menu contents,
settings persistence, or native mobile plugins.

Rebinding UI, command macros, multi-stroke sequences longer than two, context menus, global OS
hotkeys while the app is unfocused, and touch/gesture mappings are out of scope.

## Later

- Build the rebinding/conflict UI on the existing override data.
- Add context-menu projections and native mobile shortcut bridges with their subsystem designs.
- Revisit any default that manual assistive-technology testing proves unreliable.

## Decisions

- Use typed availability to produce handler arguments rather than checking capabilities in views.
- Use `event.key` by default and explicit `event.code` only for slot and macOS Option-printable
  bindings.
- Use `G then 1…9` for web buffer slots and sequences for web history navigation.
- Keep single-letter message shortcuts as optional conveniences, never the only route.
- Render macOS modifiers in `⌃⌥⇧⌘` order.
- Keep overrides device-local data with no milestone-1 UI.

## Questions for Luiz

None. The remaining uncertainty is platform verification, not a product decision.
