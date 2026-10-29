# Polish notes

A running list of visual and interaction quirks to fix in the polish pass before beta.weblounge.org. Add to it freely; one line per quirk is enough.

**Luiz's main themes (2026-10-29): alignment, text spacing and fonts.** The polish pass measures these instead of eyeballing them: compare computed font sizes, weights, line heights, paddings and gaps against the exact values in the prototype source (`docs/reference/prototype/*.dc.html`), check baseline alignment across columns (time, nick, text) and rows, consistent use of one spacing scale and one type scale from the tokens, and font loading (Inter everywhere it should be, the mono stack where the prototype uses it).

- Mobile filter chips (All / Unread / Channels / Direct) are heavy, rectangular 44px buttons; lighter than the rest of the app in the prototype.
- Time format differs between the chats list and the chat, and 12-hour "8:32 PM" is long on mobile; the prototype uses compact 24-hour "22:01".
- Send, confirmation and members-toggle buttons each have a slightly different weight and style.
- Desktop member panel still shows the old "Following #channel" chip (goes away with per-pane member lists in M2.5).
- Nick colours on the selected suggestion row (e.g. red "ana" on the green selection) have low contrast; selected rows may need the selection foreground or a contrast-checked nick colour.
- Mode symbols break nick alignment (Luiz): in the desktop member list "@ana" puts the "@" inline, so "ana" starts further right than "bruno"/"cyd". Give mode symbols a fixed-width (mono) slot so every nick starts at the same x with or without @/+, as the prototype does (Main.dc.html member rows: prefix span with a min-width in the mono stack). Same for the message list's nick column.
