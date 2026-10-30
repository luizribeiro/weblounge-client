# Dogfood log

Every issue Luiz reports from beta.weblounge.org, in the order reported, with where it stands. Pre-beta visual quirks live in `docs/polish-notes.md`.

Status: **open** (not started), **queued** (assigned, not started), **in progress**, **fixed** (commit), **deferred** (own milestone).

| # | Reported | Issue | Status |
|---|---|---|---|
| 1 | 2026-10-29 | Long (wrapping) messages make the message list jank: rows overlap. Also in scrollback: rows overlap until rendered, then the page jumps as they're corrected; new overlaps when scrolling back down (screenshot of #bots). | fixed, live |
| 2 | 2026-10-29 | Desktop (Firefox): timestamps sometimes render with an ellipsis ("12:25 P…"). | fixed, live |
| 3 | 2026-10-29 | Joining #bots shows yesterday's juniper/louro messages after today's, all stamped with the join time. | queued |
| 4 | 2026-10-29 | Mobile: after swiping back from a chat, the chats list is sometimes offset to the left, with a flash (maybe the browser's own back gesture). | fixed, live |
| 5 | 2026-10-29 | Mobile: the chats list flashes when going back to it, as if reloading. | fixed, live |
| 6 | 2026-10-29 | Desktop: with the member list open, switching channels leaves it empty (zero members). | fixed, live |
| 7 | 2026-10-29 | Mobile: focusing "Search channels and people" zooms the page. | fixed, live |
| 8 | 2026-10-29 | Mobile: two-finger pinch zooms the whole app. | fixed, live |
| 9 | 2026-10-29 | No app icon when adding the PWA to the home screen. | fixed, live |
| 10 | 2026-10-29 | Links aren't clickable. | fixed, live |
| 11 | 2026-10-29 | Link previews and inline images from files.weblounge.org. | deferred: Media milestone |
| 12 | 2026-10-29 | Loading screen: chair is black on black in dark mode; its text font, weight and colour don't match the app; it doesn't wait for assets. | fixed, live |
| 13 | 2026-10-29 | Sidebar channel order changes across reloads; the app opens in a different channel each time. | fixed, live |
| 14 | 2026-10-29 | The URL doesn't follow navigation (and reload should reopen where you were). Needs an SPA fallback on the beta server. | fixed, live |
| 15 | 2026-10-29 | Backgrounding the PWA and coming back shows the full-screen "couldn't connect" splash instead of the app with a reconnecting indicator. | fixed, live |
| 16 | 2026-10-29 | After that, opening a channel shows the connection error inside the buffer, and the app never recovers. | fixed, live |
| 17 | 2026-10-29 | Connection indicators are unreliable and untrustworthy in general. | fixed, live |
| 18 | 2026-10-29 | Beta loaded unstyled: the server CSP blocked the runtime-injected theme styles. | fixed: client live (a7211bd), server back to style-src 'self' (2a27ec4) |
| 19 | 2026-10-29 | Mobile: the members drawer's overlay lightens the content in dark mode; it must respect light/dark. | fixed, local |
| 20 | 2026-10-29 | Mobile: no gesture to close the members drawer. | fixed, local |
| 21 | 2026-10-29 | Mobile: opening the members drawer doesn't feel native: the overlay pops in instead of fading with the drawer, and swiping to open moves the overlay with the finger (likely Safari's back/forward swipe). A good open gesture is missing. | fixed, local |
| 22 | 2026-10-29 | Resizing the window doesn't keep the newest message at the bottom when you were at the live edge (also mobile keyboard, panels, composer growth). | queued |
| 23 | 2026-10-29 | The auto-complete popup flashes on each keystroke before updating. | fixed, live |
| 24 | 2026-10-29 | Desktop: after collapsing the sidebar with the hamburger, the conversation and composer don't widen to fill the window. | fixed, live |
| 25 | 2026-10-29 | Server buffer says "Channel" under its name, shows nothing, and can't be reached on mobile. (Lower priority.) | queued, last |
| 26 | 2026-10-29 | iPhone PWA: content needs space for the home indicator (the Dynamic Island is fine). Device tweaks need one organised place. | fixed, live |
| 27 | 2026-10-29 | Messages you just sent show no mode prefix ("luiz" instead of "~luiz") until reloaded from history. | fixed, live |
| 28 | 2026-10-29 | Beta console noise from our code: wasm-bindgen "deprecated parameters" warning, TanStack "Failed to get offset for index: 0", unused Inter preload, Firefox "scroll-linked positioning effect". (The webserial and CSP-eval errors come from browser extensions, not the app.) | queued (task 37, message-list rework, splash) |
| 29 | 2026-10-29 | A Shift+Enter multiline message shows as one message live, but after reload as separate rows (blank lines as empty rows) with your nick in the wrong colour. Same papo history bug as #3. | blocked on papo |
| 30 | 2026-10-30 | Mobile: the browser's back/forward swipe gestures still fight the in-app gestures. | queued |
| 31 | 2026-10-30 | Desktop: a narrow window switches to the touch-first mobile layout. It should stay a small desktop UI, with the sidebar reachable as an overlay (like the members button). | fixed, live |
| 32 | 2026-10-30 | Scrolling up loads older history but stops before the oldest message the server has. | fixed, local |
| 33 | 2026-10-30 | Every restored DM shows a red badge: read state isn't synced with the server, so all DM messages count as unread mentions. (Two indicators by design: unread dot vs mention count.) | fixed, local |
| 34 | 2026-10-30 | Links don't show the pointer (hand) cursor. | fixed, local |
| 35 | 2026-10-30 | Suggestions popup still flashes on Backspace. | fixed, local |
| 36 | 2026-10-30 | Desktop: focus isn't on the composer after joining or switching; you always have to click it (desktop focus policy not implemented). | fixed, local |
| 37 | 2026-10-30 | Firefox: the address bar doesn't follow the channel, so reload doesn't reopen it. | fixed, local |
| 38 | 2026-10-30 | History messages show no mode prefix (asked whether it can always be accurate). | queued |
| 39 | 2026-10-30 | iPhone: home-screen icon not showing; the generated icons use the line-art chair instead of the brand favicon glyph. | queued |
| 40 | 2026-10-30 | After the splash, a second 'Signing in…' screen shows a black-on-black chair (desktop too). Drop it. | fixed, local |
| 41 | 2026-10-30 | iPhone: the home-indicator space applies to every screen (chats list, members) and is too big; it should only pad the composer. | fixed, local |
| 42 | 2026-10-30 | Mobile: edge swipes still trigger browser history (e.g. back from the chats list to the splash), including in the installed PWA. | fixed, local |
| 43 | 2026-10-30 | The 'Couldn't start weblounge. Reload to try again.' screen has no retry button; a PWA has no reload. | fixed, local |
| 44 | 2026-10-30 | Mobile: the members drawer animation looks bad. | fixed, live |
| 45 | 2026-10-30 | Desktop: the favicon doesn't match the members site's (glyph on dark green). | fixed, live |
| 46 | 2026-10-30 | Sometimes the buffer scrolls on its own shortly after opening a channel. Re-check after papo's history fix. | queued |
| 47 | 2026-10-30 | Tab-completing a nick at the start of a message should add ": " (like the @ suggestion does). | fixed, local |
| 48 | 2026-10-30 | Two long live messages overlap each other, with the "New" divider drawn across the text (live on a7211bd). | fixed, live |
| 49 | 2026-10-30 | Desktop: a long draft's text spills outside the composer box instead of the box growing. | not a bug (caused by a browser extension) |
| 50 | 2026-10-30 | Long nicks are clipped mid-glyph in the nick column. | fixed, local |
| 51 | 2026-10-30 | iPhone: the home-indicator space stays under the composer while the keyboard is open (the keyboard covers the indicator). | fixed, local |
| 52 | 2026-10-30 | iOS: members sign-in succeeds but never returns to the beta chat. | fixed on the server (ed30ee5, live); please confirm on your phone |
| 53 | 2026-10-30 | iPhone home-screen app: the app stops ~63pt short of the screen bottom (band under the chats list; huge gap under the composer; drawer scrim doesn't cover it). | fixed, local |
| 54 | 2026-10-30 | iPhone: swiping from the edge to close a chat sometimes cancels mid-gesture at certain speeds (transcript touch handling?). | fixed, local |
| 55 | 2026-10-30 | iPhone: the members drawer animation is broken on device (video): while opening, the chat vanishes and the drawer renders on the left sliding further left, then snaps; closing via ✕ has no animation; another close skips most of the motion. | fixed, local (root cause: autofocusing the off-screen filter scrolled the shell; drawers now use state-driven transitions); verify on device |
| 56 | 2026-10-30 | Beta (b9d45c4) history regression: some channels empty on desktop (#bots, #ops) but not on mobile; others show week-old messages out of place with many duplicates; console `engine.read_marker_invalid`. | investigating (Opus agent) |
| 57 | 2026-10-30 | Mobile: the Back button in a chat pops instantly; it should animate out like the push animates in. | queued |
