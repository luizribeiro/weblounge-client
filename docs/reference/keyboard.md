# Keyboard (addendum to the brief)

weblounge's users are keyboard driven. **Every action in the app must be reachable from the keyboard**, with good default shortcuts on macOS and on Linux/Windows, and the shortcuts must be discoverable. This raises brief §2 ("keyboard-first") and §7.14 (command and shortcut registry) from nice-to-have to a core requirement of milestone 1.

## Principles

- **One registry.** Every action is a typed command in the command registry (brief §7.14). Shortcuts, the ⌘K switcher, the help dialog, menus (Tauri native menus, later context menus) and slash commands are all *views* of that registry. A shortcut that isn't in the registry can't exist; a command's shortcut is shown everywhere the command is (tooltips, ⌘K rows, menus, help).
- **Platform-aware bindings, written once.** Bindings use an abstract `Mod` key: ⌘ on macOS, Ctrl on Linux/Windows. Where the platforms' conventions genuinely differ (e.g. settings: ⌘, on macOS, Ctrl+, elsewhere; quitting; full screen), a command can declare per-platform bindings. Display uses each platform's conventions: glyphs on macOS (⌘⌥⇧⌃, in that order), text elsewhere (`Ctrl+Alt+Shift+K`).
- **Platform *and shell* aware.** A browser tab can't take over some shortcuts (`Ctrl/⌘+W`, `+T`, `+N`, `Ctrl+Tab`, `Ctrl+Shift+T`, …) and others clash with the browser (Firefox on Linux uses `Alt+1…9` for tabs). The keymap must know whether it's running in the web build or in Tauri, and must never bind a key the host will swallow. Every default command needs a binding that works in the web build; Tauri can add nicer ones (e.g. `Mod+W` to close a pane).
- **Layout-independent where it matters.** Match letters and symbols by the character produced (`event.key`) so they work on AZERTY, Dvorak etc., but match `Alt/⌥+digit` and other combos that macOS turns into special characters by physical key (`event.code`). Design this rule explicitly and test it.
- **Never break typing.** Ignore events during IME composition (`isComposing`). Shortcuts that conflict with text editing (plain letters, `Alt+←/→` word movement, `Ctrl+A/E/K` readline keys on macOS, etc.) are not bound while the composer or another input has focus. Single-key shortcuts (`?`, `j/k`, …) only fire when no text input is focused.
- **Scoped.** Bindings belong to a scope (global, message list, composer, switcher, settings, pane layout, onboarding, …); the innermost focused scope wins. Esc always closes the topmost overlay, then cancels the current mode, then returns focus to the composer.
- **Focus is always visible and predictable.** `:focus-visible` rings for keyboard users, roving tabindex inside lists (sidebar, member list, message list, settings nav), and focus returns where it came from when an overlay closes.
- **Rebindable later.** Don't build a rebinding UI yet, but the keymap is data (a user override layer on top of the defaults, validated for conflicts) so it can be added without refactoring. Detect and report conflicts at registry build time (a test).

## Help dialog

- Opened with `?` (when not typing) and `Mod+/`, from ⌘K ("Keyboard shortcuts"), and from a link in Settings.
- Lists every command that has a binding, grouped by scope/area, with the current platform's key labels; searchable (filter as you type); itself fully keyboard-operable.
- Generated from the registry. It never contains hand-written shortcut text.

## Proposed default keymap (a starting point, to refine in the design doc)

`Mod` = ⌘ on macOS, Ctrl on Linux/Windows. "web" marks the binding the browser build uses where the native one is unavailable.

| Area | Command | Binding |
|---|---|---|
| Global | Jump to… (switcher) | `Mod+K` |
| | Keyboard shortcuts help | `?`, `Mod+/` |
| | Settings | `⌘,` / `Ctrl+,` |
| | Focus composer | `Esc` (when nothing else to close), any printable key in the message list |
| Buffers | Previous / next buffer | `Alt+↑ / Alt+↓` (⌥ on macOS) |
| | Previous / next buffer with unread | `Alt+Shift+↑ / ↓` |
| | Jump to the most important unread (mention > DM > unread), irssi-style | `Alt+A` (by `event.code`) |
| | Go to buffer 1–9 (sidebar order) | `Mod+1…9` native; web: `Alt+1…9` except where the browser owns it (design a fallback) |
| | Back / forward in buffer history | `Mod+[ / Mod+]` |
| | Mark buffer read / mark all read | `Esc` in message list / `Shift+Esc` |
| | Join channel / start DM (the `+` button) | `Mod+Shift+K`? (pick in design) |
| Panes (desktop) | Split right / split down | `Mod+\` / `Mod+Shift+\` |
| | Focus pane left/right/up/down | `Mod+Alt+←/→/↑/↓` |
| | Move pane | `Mod+Alt+Shift+←/→/↑/↓` |
| | Grow / shrink pane (resize nearest divider) | design; dividers are also arrow-key adjustable when focused |
| | Maximize / restore pane | `Mod+Shift+Enter` |
| | Close pane | `Mod+W` native; web: pick a non-browser binding |
| Layout | Toggle sidebar / member list | `Mod+B` / `Mod+Shift+M`? (check conflicts) |
| Messages | Scroll page up/down | `PgUp/PgDn` (works from the composer) |
| | Jump to the "New" line / to the bottom | design |
| | Select message (enter message navigation) | `↑` in an empty composer, then `↑/↓` or `j/k` |
| | Reply / react / copy / delete on the selected message | `R` / `E`? / `Mod+C` / `Delete` (when capabilities allow) |
| Composer | Nick/channel/command completion | `Tab` / `Shift+Tab` |
| | Newline (multiline) | `Shift+Enter` |
| | Edit history of what you sent in this buffer | `Mod+↑/↓` (or `↑` when empty and not in message-selection mode; pick one) |
| Switcher/lists | Move / open / open beside (split) | `↑/↓` (also `Ctrl+N/P` on macOS) / `Enter` / `Mod+Enter` |

Plus server-buffer and settings bindings as each design needs.

## Requirements for the design doc (`docs/design/14-commands-and-shortcuts.md`)

- Types for commands (id, title, scope, availability predicate, e.g. driven by capabilities and layout; handler), bindings (key chord, platform/shell conditions) and the resolution order.
- The full default keymap per platform × shell, with each conflict checked against: macOS system shortcuts, the major browsers on each OS (Chrome, Firefox, Safari), GNOME/KDE, Windows, and common screen readers (VoiceOver, NVDA).
- How Tauri native menus are generated from the registry (so menu accelerators match).
- Mobile: hardware keyboards on iPad/Android should get the same bindings (iPadOS shows a ⌘-hold overlay from `UIKeyCommand`; note what's feasible).
- Tests: conflict detection, per-platform resolution and display, IME and input-focus guards, layout independence (e.g. AZERTY, Dvorak), every command having a web binding or an explicit reason why not, and Playwright tests driving the key flows (switch buffers, split/focus/close panes, open help) with the keyboard only.
