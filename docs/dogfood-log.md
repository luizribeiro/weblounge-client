# Dogfood log

Every issue Luiz reports from beta.weblounge.org, in the order reported, with where it stands. Pre-beta visual quirks live in `docs/polish-notes.md`.

Status: **open** (not started), **queued** (assigned, not started), **in progress**, **fixed** (commit), **deferred** (own milestone).

| # | Reported | Issue | Status |
|---|---|---|---|
| 1 | 2026-10-29 | Long (wrapping) messages make the message list jank: rows overlap. Also in scrollback: rows overlap until rendered, then the page jumps as they're corrected; new overlaps when scrolling back down (screenshot of #bots). | fixed, deploying (d57aa29) |
| 2 | 2026-10-29 | Desktop (Firefox): timestamps sometimes render with an ellipsis ("12:25 P…"). | fixed, live |
| 3 | 2026-10-29 | Joining #bots shows yesterday's juniper/louro messages after today's, all stamped with the join time. | queued |
| 4 | 2026-10-29 | Mobile: after swiping back from a chat, the chats list is sometimes offset to the left, with a flash (maybe the browser's own back gesture). | fixed, live |
| 5 | 2026-10-29 | Mobile: the chats list flashes when going back to it, as if reloading. | fixed, deploying (d57aa29) |
| 6 | 2026-10-29 | Desktop: with the member list open, switching channels leaves it empty (zero members). | fixed, deploying (d57aa29) |
| 7 | 2026-10-29 | Mobile: focusing "Search channels and people" zooms the page. | fixed, deploying (d57aa29) |
| 8 | 2026-10-29 | Mobile: two-finger pinch zooms the whole app. | fixed, deploying (d57aa29) |
| 9 | 2026-10-29 | No app icon when adding the PWA to the home screen. | fixed, deploying (42ab950) |
| 10 | 2026-10-29 | Links aren't clickable. | fixed, deploying (d57aa29) |
| 11 | 2026-10-29 | Link previews and inline images from files.weblounge.org. | deferred: Media milestone |
| 12 | 2026-10-29 | Loading screen: chair is black on black in dark mode; its text font, weight and colour don't match the app; it doesn't wait for assets. | fixed, deploying (d57aa29) |
| 13 | 2026-10-29 | Sidebar channel order changes across reloads; the app opens in a different channel each time. | fixed, deploying (42ab950) |
| 14 | 2026-10-29 | The URL doesn't follow navigation (and reload should reopen where you were). Needs an SPA fallback on the beta server. | fixed, deploying (d57aa29) |
| 15 | 2026-10-29 | Backgrounding the PWA and coming back shows the full-screen "couldn't connect" splash instead of the app with a reconnecting indicator. | fixed, deploying (42ab950) |
| 16 | 2026-10-29 | After that, opening a channel shows the connection error inside the buffer, and the app never recovers. | fixed, deploying (42ab950) |
| 17 | 2026-10-29 | Connection indicators are unreliable and untrustworthy in general. | fixed, deploying (42ab950) |
| 18 | 2026-10-29 | Beta loaded unstyled: the server CSP blocked the runtime-injected theme styles. | stopgap on the server; client fix queued |
| 19 | 2026-10-29 | Mobile: the members drawer's overlay lightens the content in dark mode; it must respect light/dark. | fixed, local |
| 20 | 2026-10-29 | Mobile: no gesture to close the members drawer. | fixed, local |
| 21 | 2026-10-29 | Mobile: opening the members drawer doesn't feel native: the overlay pops in instead of fading with the drawer, and swiping to open moves the overlay with the finger (likely Safari's back/forward swipe). A good open gesture is missing. | queued |
| 22 | 2026-10-29 | Resizing the window doesn't keep the newest message at the bottom when you were at the live edge (also mobile keyboard, panels, composer growth). | queued |
| 23 | 2026-10-29 | The auto-complete popup flashes on each keystroke before updating. | fixed, deploying (a7211bd) |
| 24 | 2026-10-29 | Desktop: after collapsing the sidebar with the hamburger, the conversation and composer don't widen to fill the window. | fixed, deploying (a7211bd) |
| 25 | 2026-10-29 | Server buffer says "Channel" under its name, shows nothing, and can't be reached on mobile. (Lower priority.) | queued, last |
| 26 | 2026-10-29 | iPhone PWA: content needs space for the home indicator (the Dynamic Island is fine). Device tweaks need one organised place. | fixed, deploying (42ab950) |
| 27 | 2026-10-29 | Messages you just sent show no mode prefix ("luiz" instead of "~luiz") until reloaded from history. | fixed, deploying (42ab950) |
| 28 | 2026-10-29 | Beta console noise from our code: wasm-bindgen "deprecated parameters" warning, TanStack "Failed to get offset for index: 0", unused Inter preload, Firefox "scroll-linked positioning effect". (The webserial and CSP-eval errors come from browser extensions, not the app.) | queued (task 37, message-list rework, splash) |
| 29 | 2026-10-29 | A Shift+Enter multiline message shows as one message live, but after reload as separate rows (blank lines as empty rows) with your nick in the wrong colour. Same papo history bug as #3. | blocked on papo |
| 30 | 2026-10-30 | Mobile: the browser's back/forward swipe gestures still fight the in-app gestures. | queued |
| 31 | 2026-10-30 | Desktop: a narrow window switches to the touch-first mobile layout. It should stay a small desktop UI, with the sidebar reachable as an overlay (like the members button). | fixed, deploying (42ab950) |
