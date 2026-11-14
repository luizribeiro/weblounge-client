# 30 — Inline images

Status: product decisions signed off by Luiz on 2026-11-13; slice 1 implements file host images;
slice 2 adds the full-size viewer (its library choice signed off by Luiz on 2026-11-13; see
"Viewer").

## Problem

People paste screenshots into IRC as links to their network's file host. Reading them means
leaving the app. The brief asks for media in the transcript without layout jumps (`brief.md:236`)
and for images to be released when they scroll far out of view (`brief.md:310`). IRC carries no
image dimensions, so the layout cannot wait for them.

The client is network-agnostic: weblounge.org is one network among others. Which images inline is
decided per connection from the file host that the network itself advertises, never from a
hardcoded domain.

## Decisions

- **Only the network's own file host inlines.** A network advertises its file host through
  ISUPPORT `draft/FILEHOST` or `soju.im/FILEHOST`; papo's `State::filehost()` returns it (HTTPS
  only). An image URL whose origin equals that file host's origin inlines. The file host belongs to
  the network's operator, who already relays every URL and knows the client's address, so loading
  it reveals nothing new.
- **Images from other sites never inline.** Loading them would reveal the reader's IP to arbitrary
  hosts. **Link previews are paused**: no cards, unfurling or preview service are built until Luiz
  revisits them.
- **Eligible URL:** an `http(s)` link token (from the message tokenizer) on the file host origin
  whose path ends in `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp`. SVG is never inlined.
- **One block per message:** the first eligible URL. The message text, including the URL, stays
  exactly as sent.
- **Fixed-height slot.** The slot height is a density token, decided before any fetch:

  | Density | Desktop | Phone |
  |---|---|---|
  | compact | 160px | 160px |
  | cozy | 240px | 200px |
  | comfortable | 240px | 200px |

  Comfortable follows cozy for now.

  Before load, the slot is `height × 4/3` wide and painted in the static `chip` colour (no
  shimmer). On load, its width follows the image's aspect. Both widths are clamped to
  `[64px, 360px]` on desktop and `[64px, content width]` on phone. An image whose aspect falls
  outside the clamp (a panorama, or a very tall strip at the 64px minimum) is cover-cropped. A failed
  load keeps the slot as a "Couldn't load image · Open link" tile. **The height never changes after
  first render**; only the width does, which never reflows other rows.
- **Animated images autoplay.** Under `prefers-reduced-motion: reduce`, a loaded GIF or WebP is
  replaced by a canvas holding its first frame. Drawing a cross-origin image onto a canvas only
  taints it, and the canvas is never read, so this needs no proxy or CORS.
- **Activation opens the full-size viewer** (slice 2, below). A modified or middle click keeps the
  link's native new-tab behaviour, and the error tile still opens the link.
- No spoiler or NSFW handling, and no per-message collapse (a collapse is a deliberate jump).
  Compact density uses the compact height rather than dropping images.

## Types and boundaries

- **Engine.** `NetworkProjection.filehost_origin?: string` is the ASCII origin
  (`https://host[:port]`) of the advertised file host. It is refreshed on every `Connected`, so it
  clears when a reconnect no longer advertises one, and it is retained while disconnected, as papo
  retains ISUPPORT. The engine derives only the origin; papo owns
  ISUPPORT parsing and the HTTPS rule.
- **Classifier.** `inlineImageUrl(text, filehostOrigin)` in `features/conversation` is pure: it
  reuses `tokenizeMessage` and returns the first eligible `href` or `undefined`.
- **Rows.** Timeline message rows carry `inlineImage?: string`, computed from the network of the
  row's buffer. It is part of the row's size revision. If a file host appears or changes after
  rows were rendered, those rows gain or lose their slot once, through the same re-estimate and
  scroll anchoring as any other row change; in practice the origin is known at `Connected`, before
  history arrives.
- **Component.** `InlineImage` renders an `<a>` slot (not draggable, not selectable, outside
  `Selectable`; copy and selection ignore it because the row's copy payload comes from message
  data) inside the message content column, between the text and the reaction chips, using
  the content column's 4px gap (`PLAN.md` spacing table). `/me` rows place it under the action
  text with the same gap. The `<img>` uses `loading="lazy"` and `decoding="async"`; virtualisation
  unmounts it off screen, which releases it.
- **Estimate.** `estimateMessageHeight` adds `4px + slot height` for a row with an inline image,
  in both presentations, so estimate equals measurement.
- **CSP.** `app/csp.ts` builds the policy from a deployment description instead of a fixed string.
  The beta description lists its file host for uploads (`connect-src`) and display (`img-src`); the
  hosted server's own CSP is the weblounge-server session's change. The e2e preview server adds
  `WEBLOUNGE_E2E_IMAGE_ORIGINS`, the fake file host's origin, to `img-src`, so browser specs see
  no policy violation. A static CSP cannot list other networks' file hosts: on the hosted web
  build, an image from another network's file host is blocked (one CSP console report) and shows
  the error tile with its link. That is accepted for slice 1, because the hosted build connects to
  its own network; serving other networks' images is the proxy slice's job. Tauri has no CSP.

## Testing

- Engine: a papo-testing wire advertises `draft/FILEHOST` or `soju.im/FILEHOST`; the network
  projection carries its normalised origin, and a network without one carries none.
- Unit: the classifier (origin match, extensions, SVG and other hosts rejected, first match wins,
  trailing punctuation); the estimate adds exactly the slot per density and presentation.
- Playwright against local Ergo, whose ISUPPORT advertises a fake HTTPS file host started beside
  the fake OAuth server. It serves fixture PNG and GIF files, a 404, and a held image released by
  the test. Specs: a received image renders at the slot height; releasing the held image moves no
  row and leaves `nativeFeelAudit` layout shift at zero; a 404 keeps the slot as the error tile; a
  same-shaped image URL on another host does not inline; compact density uses its height; the
  phone layout fits the content width; reduced motion shows a still frame.

## Viewer (slice 2)

Luiz: "click on the image to see it larger with support for zoom/pan/etc in an elegant view".

### Decisions

- **Library: PhotoSwipe 5.4.4 core** (MIT, ~16KB gzip JS + ~2KB CSS), loaded only when a viewer
  first opens. It provides pointer pinch, pan with momentum, double-tap zoom, ctrl+wheel and wheel
  zoom, swipe-down close and a zoom-from-thumbnail transition that animates only `transform` and
  `opacity`. Its own UI (buttons, counter, preloader), keyboard, focus trap and focus return are
  disabled; ours replace them. Its core stylesheet is imported by the lazy module, and its
  `--pswp-*` variables are set from our tokens.
- **Opening.** A click or tap on a loaded inline image, or Enter/Space when it is focused, opens the
  viewer. The slot keeps its `href`, so a modified or middle click still opens a new tab. Its
  accessible name is "Image from {nick}, open viewer". The viewer shows the same URL the slot
  loaded; there is no proxy.
- **One image at a time.** Moving between a conversation's images is a later idea.
- **Motion.** The image grows from the slot's on-screen rect to its fitted rect over
  `--wl-motion-push-in` with the push curve, and shrinks back over `--wl-motion-pop`. The slot is
  cover-cropped, so the transition starts from the cropped rect. Durations are read from the tokens
  when the viewer opens, so reduced motion (every duration token `0ms`) opens and closes instantly;
  PhotoSwipe also switches to no animation under `prefers-reduced-motion`. An animated image plays
  in the viewer even under reduced motion: opening it is an explicit request to see it.
- **Zoom.** The image opens at fit, which never upscales past natural size. Double-click and
  double-tap toggle fit and the secondary level at the pointer: `max(1, 2 × fit)`, that is actual
  pixels, or twice the fit when actual pixels would be less than that. Pinch, ctrl+wheel (Chromium
  and Firefox trackpad pinch), plain wheel and Safari/WKWebView `gesturechange` (the Mac app's
  trackpad pinch) zoom between fit and `max(4, secondary)`. `+`/`=` and `-` step by 1.5× around the
  centre, clamped to that range; `0` returns to fit. A single click on the image does nothing.
- **Pan.** Drag when zoomed, with PhotoSwipe's momentum; arrow keys pan by 80px.
- **Closing.** Escape, the close button, a click or tap on the backdrop, and a vertical swipe on
  touch, which fades the backdrop as it moves. Focus returns to the slot that opened the viewer if it
  is still mounted; if virtualisation removed it, focus stays on the document, where typing still
  reaches the composer, and the close fades instead of shrinking to the slot.
- **Chrome.** No bar: the sender's nick, the message time, an "Open original" link (new tab,
  like message links) and a close button sit straight on the backdrop along the top edge, inside
  the safe areas. The backdrop is `--wl-color-overlay-scrim`, as for the omnibar, drawers and
  confirmations, so the app stays visible and dimmed behind the image.
- **Legibility.** The scrim is translucent, so what shows through under the controls varies: the
  app's own text, accent rows, or the image when zoomed. No text token holds 4.5:1 against the
  scrim over every theme colour (`--wl-color-fg` falls to 1.1:1 over light-theme text and 3.6:1
  over dark-theme text). The controls therefore carry a soft halo in `--wl-color-surface` (a
  text-shadow on the text, a drop-shadow on the close icon), which brings each glyph close to
  its contrast on the surface (fg 13.4:1 light, 14.1:1 dark) whatever is behind it. The close icon
  uses `--wl-color-fg`.
- **Zoomed in.** The image may pan under the controls. They stay put and visible, with no fade
  while dragging, so Close is always one tap away; the halo keeps them readable over the image.
  At fit, the image sits inside a CSS fit box below the controls' 48px (44px on phone) row, with
  a 24px margin on desktop and the safe-area insets (`--wl-safe-*`) on phone; the viewer measures
  that box rather than reading safe areas itself.
- **Accessibility.** The viewer root is `role="dialog"`, `aria-modal="true"`, labelled "Image from
  {nick}". Opening it focuses the dialog with `preventScroll`; Tab cycles inside it through the
  shared trap extracted from `OmnibarOverlay`; the rest of the app root is `inert` while it is open;
  a polite status says "Image from {nick}. Press Escape to close." PhotoSwipe's nested `role` and
  carousel descriptions are removed, since there is one image.
- **Keyboard ownership.** While open, the viewer captures every keydown at the document and stops
  propagation, wherever focus is, so application shortcuts and printable-key forwarding do not
  reach the shell behind a modal. Its Escape closes it locally, like the omnibar's, instead of
  through `navigation.escape`: no shell command can run while the viewer is open.
- **Idle.** No frame or timer runs while the open viewer is still: PhotoSwipe schedules rAF only
  during gestures and animations, and its one-shot transition-start timers end with each
  animation. The viewer unmounts on close and removes its listeners.

### Types and boundaries

- `features/image-viewer/image-viewer-request.ts`: the one current request,
  `{ url, author, time, naturalWidth, naturalHeight, origin: HTMLElement }`, with
  `openImageViewer` (ignored while a viewer is open) and `closeImageViewer`.
  `ImageViewerOutlet`, the last child of the app root, renders the viewer for it.
- `features/image-viewer/ImageViewer.tsx`: the dialog, its controls, status and focus handling; loaded
  with `lazy()`, so it and PhotoSwipe form their own chunk.
- `features/image-viewer/photoswipe-viewer.ts`: creates and configures the PhotoSwipe instance and
  exposes `close`, `destroy` and `run(command)` for the key commands.
- `features/image-viewer/viewer-zoom.ts` and `viewer-keys.ts`: pure zoom levels and steps, token
  duration parsing, and the key → command map.
- `ui/focus-trap.ts`: `trapTab(event, root)`, shared by the omnibar and the viewer.
- `InlineImage` gains `time` and opens the viewer once it has loaded; loading and failed slots keep
  their link.
- `photoswipe-viewer.ts` keeps PhotoSwipe's placeholder (a transparent block) for the viewer's
  lifetime, so no removal timer runs after the image loads.

### Testing

- Unit: zoom levels and steps, duration parsing, the key map, the focus trap, the request store, the
  adapter's fit-box padding, backdrop test and commands, InlineImage's open
  request (click, Enter/Space, modified click, failed tile), and the dialog's labels, status, focus
  and close button with PhotoSwipe stubbed.
- Playwright against local Ergo and the fake file host: open by click and by keyboard; `+`, `-`,
  `0` and double-click change the scale; a drag pans when zoomed; Escape and the close button close
  it and return focus; phone tap opens and a swipe down closes; reduced motion opens with no
  running animation; `nativeFeelAudit` (idle and hidden page) passes with the viewer open and after
  close; the viewer chunk is fetched only when it first opens.
- Screenshots: desktop 1280 light and dark at fit and zoomed, and phone.

### Later ideas

- Moving between the conversation's images (arrows, swipe).
- Android hardware back closing the viewer through the navigation stack.
- Copy link and Save (Tauri) beside Open original.

## Out of scope (next slices)

- A natural-size cache in the engine's `Space::Cache` (needs a new protocol request and records),
  so first paint after reload already has the final width.
- Persisting `filehost_origin` in the chat-list snapshot: until a network connects, its images
  do not inline, and history only arrives after connecting.
- Link preview cards, third-party images and any proxy; uploads from the composer.
