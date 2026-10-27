# 14 — Commands and shortcuts

Status: proposed for milestone 1 review.

## Problem

Every app action needs one typed identity and one availability rule. Keyboard shortcuts, the
switcher, help, buttons, tooltips, Tauri menus, slash commands, and later context menus are views
of that registry; none may invent an action ID, label, or binding. Defaults must work in both a
browser and Tauri without corrupting text entry or assuming a US keyboard. Their primary audience
is people arriving from Slack or Discord; familiarity with terminal IRC clients or Vim is not
assumed.

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
- `event.code` is used only by bindings marked `code`: native buffer slots and every
  macOS Option-plus-printable default (letter, digit, or punctuation), because Option can turn the
  intended key into `å`, `¡`, or another character. Arrows and named keys still use `event.key`.
- Never treat `Ctrl+Alt` as a shortcut when `getModifierState("AltGraph")` is true. This preserves
  characters entered with AltGr on Windows and Linux.
- `input: "never"` excludes `input`, `textarea`, `select`, contenteditable, ARIA textbox, and the
  composer. `nonText` admits modified app commands but excludes plain keys and OS/readline editing
  chords. `emptyComposer` additionally requires no text, selection, completion, or composition.
- Contextual arrows, Enter, Delete, and Escape run only in the widget or mode that owns them.
  macOS readline chords (`Ctrl+A/E/K/N/P`) and word movement (`Alt+Left/Right`) are never captured
  in text. `Ctrl+N/P` is an extra only inside the switcher/list widget.
- Repeats are allowed only for list/message motion, page scrolling, and pane resizing. Destructive,
  overlay, split, send, and navigation commands deny repeats.
- A printable key in the message list focuses the composer and then inserts through normal input;
  it is not prevented or replayed synthetically.

## Default keymap

Slack's current desktop/web list and Discord's current shortcut and keyboard-navigation guides are
the research sources. “Both” means their binding agrees; “ours” means neither product has a safe
equivalent. The macOS and Linux/Windows columns are Tauri defaults. Web uses “same” only where the
browser delivers the chord; otherwise the listed scoped key or focusable control is the fallback.
An action-menu route means focus a message, press Enter or the platform Menu key, then choose the
action. It is a contextual keyboard route, not a hidden sequence.

Research references: [Slack keyboard shortcuts](https://slack.com/help/articles/201374536-slack-keyboard-shortcuts),
[Slack keyboard navigation](https://slack.com/help/articles/115003340723-Navigate-Slack-with-your-keyboard),
[Discord shortcut guide](https://support.discord.com/hc/en-us/articles/31232432266647-Discord-Commands-Shortcuts-and-Navigation-Guide),
[Discord Quick Switcher](https://support.discord.com/hc/en-us/articles/115000070311-Quick-Switcher),
and [Discord keyboard navigation](https://discord.com/blog/how-to-navigate-discord-using-only-your-keyboard).

| Command ID — action | macOS | Linux / Windows | Web fallback or context | Source |
|---|---|---|---|---|
| `switcher.open` — Jump to / browse channels and DMs | `⌘K` | `Ctrl+K` | same | both |
| `shortcuts.open` — shortcut help | `⌘/` | `Ctrl+/` | same | both |
| `settings.open` — settings | `⌘,` | `Ctrl+,` | `Enter` on Settings control/switcher row | both |
| `navigation.escape` — close/cancel/focus composer | `Esc` | `Esc` | scope cascade above | both |
| `navigation.back` / `navigation.forward` | `⌘[` / `⌘]` | `Alt+Left` / `Alt+Right` | `Enter` on Back/Forward control or switcher row | Slack |
| `search.open` — search current surface | `⌘F` | `Ctrl+F` | same; intentionally replaces find-in-page | both |
| `buffer.open` — join channel/start DM | `Enter` on Add control/switcher row | same | same | Slack/Discord route |
| `buffer.previous` / `buffer.next` | `⌥Up` / `⌥Down` | `Alt+Up` / `Alt+Down` | same; never in text | both |
| `buffer.previous-unread` / `buffer.next-unread` | `⌥⇧Up` / `⌥⇧Down` | `Alt+Shift+Up` / `Alt+Shift+Down` | same; never in text | both |
| `buffer.jump-important` | `Enter` on switcher row | same | same | ours |
| `buffer.jump-1` … `buffer.jump-9` | `⌘1` … `⌘9` | `Ctrl+1` … `Ctrl+9` | `Enter` on switcher row | ours, native only |
| `buffer.mark-read` | `Esc` in message list | `Esc` in message list | same, via `navigation.escape` | both |
| `buffer.mark-all-read` | `⇧Esc` | `Shift+Esc` | `Enter` on Mark-all-read control/switcher row | both, native only |
| `buffer.load-older` | `Enter` on history-boundary control | same | same | ours |
| `pane.focus` / `pane.show-buffer` | focus pane / `Return` on selected buffer | focus pane / `Enter` | same | ours |
| `pane.open-buffer-right` | `⌘Return` | `Ctrl+Enter` | selected sidebar/switcher row; same | Slack |
| `pane.split-right` / `pane.split-down` | `⌘\` / `⇧⌘\` | `Ctrl+\` / `Ctrl+Shift+\` | `Enter` on pane-header control/switcher row | ours, native only |
| `pane.focus-left`, `pane.focus-right`, `pane.focus-up`, `pane.focus-down` | `Enter` on pane control/switcher row | same | same | ours |
| `pane.move-left`, `pane.move-right`, `pane.move-up`, `pane.move-down` | arrows + `Enter` in Place dialog/switcher | same | same | ours |
| `pane.grow` / `pane.shrink` | focused separator arrows | same | same | ours |
| `pane.toggle-zoom` | `⇧⌘Return` | `Ctrl+Shift+Enter` | same | ours |
| `pane.close` | `⌘W` | `Ctrl+W` | `Enter` on pane-header Close/switcher row | ours, native only |
| `sidebar.toggle` | `Enter` on sidebar control/switcher row | same | same | ours |
| `members.toggle` | `⌘.` | `Ctrl+.` | same | Slack right sidebar |
| `message.page-up` / `message.page-down` | `PgUp` / `PgDn` | `PgUp` / `PgDn` | same, including empty composer | both |
| `message.jump-new` / `message.jump-bottom` | `⇧PgUp` / `End` | `Shift+PgUp` / `End` | message-list scope; same | Discord / Slack |
| `message.select-last` | `Up` in empty composer | `Up` in empty composer | selects latest own message; see below | both expectation, ours behavior |
| `message.previous` / `message.next` | `Up` / `Down` | `Up` / `Down` | message-navigation mode | both |
| `message.actions.open` | `Return` or Menu | `Enter` or Menu | selected-message scope | Slack/Discord route |
| `message.reply` / `message.react` | Message Actions | same | same; capability-gated | both route |
| `message.copy` | `⌘C` | `Ctrl+C` | selected message; DOM selection wins first | Discord |
| `message.redact` | `Delete` | `Delete` | selected own message; confirmation required | Slack |
| `message.retry` | `Return` | `Enter` | focused failed-message control | ours |
| `composer.send` / `composer.newline` | `Return` / `⇧Return` | `Enter` / `Shift+Enter` | composer only | both |
| `composer.complete-next` / `composer.complete-previous` | `Tab` / `⇧Tab` | `Tab` / `Shift+Tab` | completion open; otherwise focus moves | both convention |
| `composer.history-previous` / `composer.history-next` | `⌘Up` / `⌘Down` | `Ctrl+Up` / `Ctrl+Down` | nonempty composer only | Discord |
| `composer.upload` — attach file (later) | `Enter` on Attach control | same | same | Slack/Discord route |
| `list.previous`, `list.next`, `list.open`, `list.open-beside` | arrows, `Return` / `⌘Return` | arrows, `Enter` / `Ctrl+Enter` | focused list scope | Slack/Discord route / Slack |
| `separator.decrease` / `separator.increase` | arrow; `⇧` = 10× | arrow; `Shift` = 10× | focused separator | ARIA / ours |
| `mobile.tab-chats`, `mobile.tab-activity`, `mobile.tab-settings` | `⌘1/2/3` | `Ctrl+1/2/3` | Tauri mobile hardware keyboard only | ours |
| `network.connect`, `network.disconnect`, `network.open-server`, `network.add`, `network.remove`, `channel.part` | `Return` | `Enter` | focused control or switcher | ours |
| `network.import-bouncer` / `push.configure` | `Return` | `Enter` | focused control/switcher when projected by 17 | ours |
| `activity.mark-all-read` | `⇧Esc` | `Shift+Esc` | `Enter` on Mark-all-read control/switcher row | both, native only |

Slack defaults Up in an empty composer to edit the last sent message, and Discord documents edit
last message there as well. IRC has no interoperable edit operation. Weblounge therefore makes
`message.select-last` select the newest visible message authored by the current account and enter
message navigation; the user can reply, copy, or redact it when those actions exist. It does not
copy the old body into the composer, because sending that text would create a duplicate message
that only resembles an edit. If no own message is visible, Up has no effect.

The research cross-check also found Slack's desktop-only `Mod+O` and Discord's `Mod+Shift+U` for
upload. Both conflict with browser/OS behavior, and uploads are later work, so `composer.upload`
uses the accessible Attach control until that subsystem chooses a safe capability-gated binding.
Slack uses `Mod+Shift+K` to browse DMs on macOS and Discord folds DMs into `Mod+K`; Weblounge uses
the shared `switcher.open` behavior and does not bind `Ctrl+Shift+K`, which is Firefox Web Console.

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
| `Mod+K`, `Mod+/`, `Mod+F` | Browsers assign omnibox/quick-find/find behavior, but Slack and Discord web use the first two. Search intentionally replaces find. **Verify** delivery in every browser; controls and switcher rows remain available. |
| native `Mod+,` | Browser preferences may win, so it is not a web default. Settings remains a focusable control and switcher row. |
| native `Mod+1…9` | Chrome, Firefox, and Safari select browser tabs. Never registered on web; the switcher is the web route. |
| native `Mod+[` / `Mod+]`, `Alt+Left/Right` | Safari and other browsers own history navigation. These are Tauri-only; web exposes Back/Forward controls and switcher commands. |
| native `Mod+W` | Closes a browser tab/window and is intentionally Tauri-only. The web fallback is the pane-header Close control or switcher. |
| `Alt+Up/Down`, `Alt+Shift+Up/Down` | macOS paragraph movement and Windows/NVDA reading commands matter in editable/read modes, so these are suppressed in text. GNOME may expose menu mnemonics on Alt; **verify** installed-app webviews. |
| `Mod+Alt+arrows`, shifted variants | Not defaults: GNOME/Ubuntu commonly use them for workspaces, Windows Intel drivers may use them for display rotation, Windows Magnifier may pan, and Control+Option is VoiceOver's modifier. Pane controls, switcher commands, and the Place dialog replace them. |
| `Ctrl+Shift+A`, `Ctrl+Shift+M`, `Ctrl+Shift+K` | Not defaults: Chrome/Firefox reserve or use these for tab search/add-ons, profile/responsive mode, and Firefox Web Console respectively. Mark-all-read, members, and DM/browse use the routes above. |
| native `Mod+\`, `Mod+Shift+\` | Safari uses Shift+Command+backslash for tab overview. Split chords are Tauri-only; web pane-header controls and switcher commands are the fallback. |
| `Mod+Shift+Enter` | No major browser or desktop reservation was found. It remains **verify** on Safari, VoiceOver, GNOME, and KDE before release. |
| `Mod+.` | Slack establishes this for the right sidebar and no major browser reservation was found. macOS Command-period is also a conventional Cancel command, so member-panel delivery remains **verify** in Safari/webviews. |
| `Shift+PgUp`, `End`, `PgUp/PgDn`, arrows, Tab, Enter, Escape, Delete | Browser scrolling, native editing, and screen-reader browse modes use these. They run only in the owning widget/mode; real controls retain native semantics. **Verify** NVDA browse/focus behavior. |
| `Ctrl+P/N` | macOS readline previous/next and browser print/new-window conventions. Registered only inside the open list widget; never in composer or ordinary inputs. Arrow alternatives are primary. |
| `Shift+Escape` | Chrome and Firefox use it for Task Manager on Windows/Linux and may reserve it. It is Tauri-only; web uses the focusable Mark-all-read control or switcher. **Verify** each Tauri webview. |

Defaults do not use `Mod+T/N/Q`, `Ctrl+Tab`, `Ctrl+Shift+T/N`, `Alt+F4`, or system Meta/Super
shortcuts. User overrides may request them in Tauri but validation rejects them for web.

## Help and binding presentation

`shortcuts.open` opens a modal generated from available registry entries. It groups Global,
Navigation, Panes, Messages, Composer, Lists, and Settings; search matches localized title,
command ID, and rendered chord. Results update while typing, use a roving list, and close through
`navigation.escape`, restoring the invoker. `Mod+/`, a “Keyboard shortcuts” switcher row, and
the Settings link all dispatch the same command.

The formatter uses the current platform and active shell. macOS modifier glyphs always render in
Apple HIG order `⌃⌥⇧⌘` (correcting the addendum's `⌘⌥⇧⌃` example), omits `+`, and localizes key
names. Other platforms render `Ctrl+Alt+Shift+K`. `aria-keyshortcuts` uses WAI-ARIA tokens such as
`Control+K`, never glyphs. Optional-preset sequences are described in the accessible name because
ARIA has no sequence syntax.

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
- Playwright drives only the keyboard to switch buffers through the switcher, mark read, open/help
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
- Offer an optional “terminal/Vim” preset containing the old `G then …` and `S then …` sequences
  plus single-letter message actions. They are never defaults or the only route to an action.

## Decisions

- Use typed availability to produce handler arguments rather than checking capabilities in views.
- Use `event.key` by default and explicit `event.code` only for slot and macOS Option-printable
  bindings.
- Render macOS modifiers in `⌃⌥⇧⌘` order.
- Keep overrides device-local data with no milestone-1 UI.
- Luiz, 2026-10-27: optimize defaults for people coming from Slack and Discord; keep terminal/Vim
  sequences and single-letter message actions in an optional later preset only.
- Luiz, 2026-10-27: Up in an empty composer selects the latest visible own message for navigation;
  it does not simulate an IRC message edit.

## Questions for Luiz

None. The remaining uncertainty is platform verification, not a product decision.
