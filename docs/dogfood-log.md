# Dogfood log

Every issue Luiz reports from beta.weblounge.org, in the order reported, with where it stands. Pre-beta visual quirks live in `docs/polish-notes.md`.

Status: **open** (not started), **queued** (assigned, not started), **in progress**, **fixed** (commit), **deferred** (own milestone).

| # | Reported | Issue | Status |
|---|---|---|---|
| 1 | 2026-10-29 | Long (wrapping) messages make the message list jank: rows overlap. Also in scrollback: rows overlap until rendered, then the page jumps as they're corrected; new overlaps when scrolling back down (screenshot of #bots). | fixed in 72a71c2 (not deployed yet); re-verify the scrollback case after deploy, research on the approach running |
| 2 | 2026-10-29 | Desktop (Firefox): timestamps sometimes render with an ellipsis ("12:25 P…"). | fixed |
| 3 | 2026-10-29 | Joining #bots shows yesterday's juniper/louro messages after today's, all stamped with the join time. | queued |
| 4 | 2026-10-29 | Mobile: after swiping back from a chat, the chats list is sometimes offset to the left, with a flash (maybe the browser's own back gesture). | fixed |
| 5 | 2026-10-29 | Mobile: the chats list flashes when going back to it, as if reloading. | queued |
| 6 | 2026-10-29 | Desktop: with the member list open, switching channels leaves it empty (zero members). | queued |
| 7 | 2026-10-29 | Mobile: focusing "Search channels and people" zooms the page. | queued |
| 8 | 2026-10-29 | Mobile: two-finger pinch zooms the whole app. | queued |
| 9 | 2026-10-29 | No app icon when adding the PWA to the home screen. | queued |
| 10 | 2026-10-29 | Links aren't clickable. | queued |
| 11 | 2026-10-29 | Link previews and inline images from files.weblounge.org. | deferred: Media milestone |
| 12 | 2026-10-29 | Loading screen: chair is black on black in dark mode; its text font, weight and colour don't match the app; it doesn't wait for assets. | queued |
| 13 | 2026-10-29 | Sidebar channel order changes across reloads; the app opens in a different channel each time. | queued |
| 14 | 2026-10-29 | The URL doesn't follow navigation (and reload should reopen where you were). Needs an SPA fallback on the beta server. | queued |
| 15 | 2026-10-29 | Backgrounding the PWA and coming back shows the full-screen "couldn't connect" splash instead of the app with a reconnecting indicator. | queued |
| 16 | 2026-10-29 | After that, opening a channel shows the connection error inside the buffer, and the app never recovers. | queued |
| 17 | 2026-10-29 | Connection indicators are unreliable and untrustworthy in general. | queued |
| 18 | 2026-10-29 | Beta loaded unstyled: the server CSP blocked the runtime-injected theme styles. | stopgap on the server; client fix queued |
| 19 | 2026-10-29 | Mobile: the members drawer's overlay lightens the content in dark mode; it must respect light/dark. | queued |
| 20 | 2026-10-29 | Mobile: no gesture to close the members drawer. | queued |
| 21 | 2026-10-29 | Mobile: opening the members drawer doesn't feel native: the overlay pops in instead of fading with the drawer, and swiping to open moves the overlay with the finger (likely Safari's back/forward swipe). A good open gesture is missing. | queued |
| 22 | 2026-10-29 | Resizing the window doesn't keep the newest message at the bottom when you were at the live edge (also mobile keyboard, panels, composer growth). | queued |
| 23 | 2026-10-29 | The auto-complete popup flashes on each keystroke before updating. | queued |
| 24 | 2026-10-29 | Desktop: after collapsing the sidebar with the hamburger, the conversation and composer don't widen to fill the window. | queued |
| 25 | 2026-10-29 | Server buffer says "Channel" under its name, shows nothing, and can't be reached on mobile. (Lower priority.) | queued, last |
