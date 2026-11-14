# 30 — Inline images

Status: product decisions signed off by Luiz on 2026-11-13; slice 1 (this doc) implements file host
images.

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
- **Activation opens the URL in a new tab**, as the text link does. The full-size viewer replaces
  this in the next slice.
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

## Out of scope (next slices)

- The full-size zoom and pan viewer.
- A natural-size cache in the engine's `Space::Cache` (needs a new protocol request and records),
  so first paint after reload already has the final width.
- Persisting `filehost_origin` in the chat-list snapshot: until a network connects, its images
  do not inline, and history only arrives after connecting.
- Link preview cards, third-party images and any proxy; uploads from the composer.
