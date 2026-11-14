# 31 — Image uploads from the composer

Status: product decisions signed off by Luiz on 2026-11-13. This addendum to designs 13 (composer)
and 30 (inline images) covers v1: paste one image from the clipboard and send it. Research:
`draft/FILEHOST` (IRCv3 PR #562) and `soju.im/FILEHOST`, gamja, senpai and Goguma.

## Problem

People paste screenshots into chat. IRC carries text, so an image travels as a link on the
network's file host, which design 30 then shows inline. Today the user must upload elsewhere and
paste the link. The client stays network-agnostic: each network's upload goes to the file host
that network advertises, authenticated the way its IRC connection is, and nothing about weblounge's
hosts is hardcoded.

## Decisions

- **Endpoint.** The upload goes to papo's `State::filehost()` for that connection (`draft/FILEHOST`
  first, then `soju.im/FILEHOST`, HTTPS only). A network without one has no uploads: an image paste
  is not intercepted and a neutral note above the composer says "This network doesn't accept
  uploads."
- **Authorization mirrors SASL** (the spec's rule). SASL PLAIN becomes HTTP `Basic` from the account
  and password the engine was given. A hosted OAuth login becomes `Bearer` with a fresh token from
  the deployment's own session-token endpoint (config.json's `oauth.session_token_endpoint`), never
  the consumed one-shot SASL token. papo never returns secrets, so the engine keeps its own redacted
  copy of the PLAIN credential, in memory only, for the life of the connection.
- **U1, password release.** The engine releases the Basic credential automatically only when the
  file host is on the IRC server's own site. Otherwise the UI asks once, naming the host, with a
  "Remember for this network" choice; a host that changes asks again. Bearer logins never prompt:
  the token is short-lived and was minted by the same deployment. The rule is the pure function
  `release_credential` (below).
- **U2.** Nothing leaves the device until the user sends: the upload starts on Enter or Send, not
  on paste.
- **U3.** One `PRIVMSG`: the caption, a space, the URL; the URL alone without a caption. It goes
  through `SubmitInput` like typed text, so `/me caption` plus an image becomes an action, and
  papo frames a multiline caption as it does any text. A caption that is any other slash command
  is refused before anything is uploaded.
- **U4.** PNG, JPEG, GIF and WebP (sniffed by magic bytes) are sent as they are. Anything else the
  browser can decode (HEIC, TIFF, AVIF) is re-encoded: JPEG (quality 0.9) for an opaque image, PNG
  when any pixel is translucent. A file the browser cannot decode fails as "Can't read this image"
  without uploading. Images are shrunk only after a `413` that carries `Upload-Limit: maxsize=N`:
  both sides scale by `sqrt(0.9 N / size)`, re-encoded as above (translucent stays PNG), and the
  upload is retried once; a second `413`, or a `413` without a limit, fails as too large. A GIF is
  never shrunk, because rasterizing drops its animation.
- **U5.** JPEG metadata is stripped client-side, losslessly, by allow-list: the image markers
  (SOF, DHT, DQT, DRI, SOS and the scan) stay, and of the application segments only JFIF (APP0),
  ICC (APP2) and Adobe (APP14) stay, because decoders need them for colour. Every other APPn (EXIF,
  XMP, MPF, maker notes, Photoshop) and COM is dropped, and the EXIF orientation, when it is not 1,
  is kept in a fresh minimal APP1, so phone photos are not shown rotated. Re-encoded images carry no
  metadata; `createImageBitmap` applies the orientation once while decoding. Some file hosts scrub,
  but not every network's does.
- **U6.** The attachment lives in memory with the composer of one conversation. It is not saved
  with the draft, so a reload drops it and keeps the text, and switching conversations aborts and
  drops it. Sending while the network is offline is refused before any upload, like a command that
  needs a connection. Once uploaded, the attachment keeps its URL: if `SubmitInput` is then
  rejected (the connection dropped meanwhile), the chip fails with Retry, which resubmits the same
  URL instead of uploading again. Like the draft (design 13), the attachment is removed only after
  the submission is accepted.
- **U7.** A clipboard with text and an image attaches the image and lets the text paste through;
  only a lone image paste is prevented.
- **U8.** One image per message. A second paste replaces the first. Only while an upload is in
  flight does an inline confirmation ask first; confirming aborts that upload.
- **Transfer** runs on the UI thread with `XMLHttpRequest` behind an `Uploader` port: it is the only
  cross-browser way to get upload progress, abort is `xhr.abort()`, and the pasted `Blob` already
  lives in the UI. A native uploader (for a bundled Tauri origin without CORS) can replace it behind
  the same port later.

### U1: the own-site rule

```rust
enum Approval { None, Granted } // Granted: this upload's approval or a remembered one
fn release_credential(irc_host: &str, filehost_host: &str, credential: CredentialKind,
    approval: Approval) -> Release // Send | Ask
```

- `irc_host` is the host of the WebSocket endpoint the connection was configured with (the URL the
  user or deployment gave), not a name the server reports. `filehost_host` is the host of papo's
  advertised file host URL, which is always HTTPS.
- Hosts are compared ASCII-lowercased with one trailing dot removed; ports are ignored for the site
  test.
- **Own site** means: the hosts are equal; or both have the same *registrable domain* (the public
  suffix plus one label) by the Public Suffix List, ICANN and private sections both.
  `irc.example.org` and `files.example.org` match; `alice.github.io` and `bob.github.io` do not,
  because `github.io` is a public suffix; `127.0.0.1` matches only itself.
- Hosts that only match themselves: IP-like hosts (IPv6 in brackets, or a last label that does not
  start with a letter, which covers dotted, decimal and hex IPv4 forms, since no TLD does), a
  host with no registrable domain (a bare public suffix, a single label like `localhost`), and any
  host with a punycode (`xn--`) label, because the list's internationalized rules are not in ASCII
  form and skipping them must never widen a match.
- The list is a vendored, comment-free copy of its ASCII rules
  (`crates/engine/data/public-suffixes.txt`, regenerated by the command in its header), matched by
  a small lookup in the engine. The `psl` crate would add about 1 MB to the engine's wasm (+53%).
- Bearer is always `Send`. Basic is `Send` on its own site or with `Approval::Granted`, and `Ask`
  otherwise. The engine folds approvals in: a request's approval counts only when its host equals
  the file host authority the engine resolves at that moment, so the UI cannot approve a host it was
  not asked about, and a changed host asks again.
- **Remembered approvals** are a device-local `Space::Settings` record (design 22) keyed by the
  connection endpoint, the SASL account and the file host's authority (host and port, so approving
  `files.example.net:8443` does not cover `:443`). A one-time approval is not stored and covers only
  the upload that asked. `ForgetUploadApprovals` clears every remembered approval; until the
  Networks settings section brings its switch, nothing in the UI calls it, a deliberate v1 gap.
- **Residual risk.** The PSL is the trust boundary: on a domain that hands out subdomains to other
  parties without being listed (some universities and companies), a sibling of the IRC host would
  receive the password. The rule also trusts names, not DNS or certificates beyond HTTPS. Browsers
  remove `Authorization` on a cross-origin redirect (Fetch), and `XMLHttpRequest` cannot refuse
  redirects, so a same-origin redirect stays on the approved host; the uploader also requires the
  final `responseURL` to be the endpoint's origin before trusting a `201`.
  Ports are ignored for the site test, so another service on the IRC host's own site also
  qualifies. A Bearer token goes to whatever file host the hosted server advertises: the engine
  checks neither its audience nor its lifetime, and relies on the deployment minting short-lived
  tokens for its own concierge.
- **Parsing.** The engine accepts an advertised upload URL only when its authority is a plain host
  name, an IPv6 literal and an optional port: userinfo, percent-escapes, backslashes, spaces and
  other characters are refused, so the host it judges is the host the browser will contact.

## Types and boundaries

- **Engine.** `EngineRequest::ResolveUpload { network_id, approval? }` with
  `UploadApproval { host, remember }` answers `EngineToUi::UploadResolved { command_id, resolution }`:
  - `unavailable`: no file host advertised;
  - `offline`: the network is not connected;
  - `approval_required { host }`: U1 says ask;
  - `ready { endpoint, authorization }` with `authorization` either `basic { header }` (a
    `RedactedSecret` holding the whole `Basic …` value, serialized as a string) or `host_bearer`.

  The worker routes `UploadResolved` only to the requesting tab, as it does push credentials. The
  header thereby reaches that tab's UI thread and the XHR: it is resolved per upload, never cached,
  logged or stored by the UI. An `unavailable` answer while the projection still shows a file host
  is a race after a reconnect and shows the no-uploads note.
  `ForgetUploadApprovals` answers with a `CommandResult`. The engine owns endpoint choice,
  credentials, U1 and its storage; it has no HTTP client.
- **Uploader port** (`app/src/platform/upload/`). `upload({ endpoint, authorization, body,
  filename, onProgress, signal })` sends `POST` with `Content-Type`,
  `Content-Disposition: inline; filename*=UTF-8''…` and `Authorization`, without cookies, and
  resolves `Location` against the endpoint. Outcomes are a closed union: `uploaded { url }`,
  `unauthorized`, `too_large { limit? }`, `unsupported_type`, `rate_limited`, `quota_full`,
  `failed { status, detail? }` (the first 200 characters of a `text/plain` body), `network`,
  `aborted`. `413` reads `Upload-Limit`; a 201 without a usable `https:` Location is `failed`.
- **Image preparation** (`features/uploads/`). Pure byte functions sniff the type and strip JPEG
  metadata; re-encoding and shrinking sit behind a small `ImageCodec` port (`createImageBitmap` and
  `OffscreenCanvas`) so the pipeline is testable without a browser.
- **Send pipeline.** `uploadImage` prepares the bytes, resolves the target, asks for approval
  through a `confirm(host)` port when needed (then resolves again with the approval), and for
  `host_bearer` asks the deployment's `SessionTokenProvider` for a fresh token; without a provider,
  or when it fails, the upload fails as `unauthorized`. It uploads, and on `too_large` shrinks and
  retries once. A `401` is not retried. It returns the URL or a typed failure; the composer then
  submits `caption URL`. The `Location` may be on another origin (a CDN); such a link sends but
  does not inline (design 30), an accepted limit.

  | Failure | Chip text |
  |---|---|
  | offline | You're offline. |
  | declined approval | Upload cancelled. |
  | `unauthorized` | The file host refused your sign-in. |
  | `too_large` | Image is too large (with the limit when known). |
  | `unsupported_type` / undecodable | Can't upload this kind of image. / Can't read this image. |
  | `rate_limited` | Too many uploads. Try again later. |
  | `quota_full` | Your upload space is full. |
  | `failed`, `network` | Upload failed. (with the server's short detail when there is one) |
  | command caption | Send commands without an image. |
- **Composer.** The attachment state is a closed union: `ready`, `uploading { progress }`,
  `failed { reason }`. The composer accepts an optional `uploads` prop; its absence means the
  network has no file host (from `NetworkProjection.filehost_origin`).

## Composer UI

Following the "photo tray inside the field" in the composer mockup
(https://claude.ai/artifact/5t4PxSRMMtVdQG3bthYh3C, boards Composer and ComposerStates), compacted as
Luiz asked:

- A chip inside the field, above the text and below a future reply strip: a 40px rounded
  thumbnail (`blob:` URL, revoked on remove or send), a one-line label ("Image · 1.2 MB") and a ×
  button labelled "Remove image" (44px hit area on touch).
- Uploading draws a thin determinate bar along the chip's bottom edge; the chip is `aria-busy`,
  and a polite live region announces "Uploading image" and failures.
- Send stays enabled with an attachment and no text. While the upload runs, Send shows busy and
  ignores presses; the message goes when the upload finishes. × or leaving the conversation aborts
  it.
- A failure turns the chip error-toned with a short reason and Retry; the text stays.
- Esc in a composer with no text and an attachment removes the attachment. It is composer-local,
  like closing suggestions (design 13): suggestions close first, and an Escape with no text, no
  suggestions and no attachment still does nothing (design 14).
- The approval prompt extends `ConfirmationDialog` with an explanation line and an optional
  "Remember" checkbox. It returns focus to the composer (design 15).
- No Attach button or picker yet; `composer.upload` (design 14) arrives with arbitrary files.
- Tokens only; the chip uses `chip`, `panel-border`, `accent` and `error` colours and the motion
  tokens.

## CSP

The beta policy already allows `blob:` in `img-src` and the file host's `/upload` in `connect-src`
(`app/csp.ts`). The e2e policy adds the fake file host's upload URL under both of its names,
`https://127.0.0.1:4175` (own site of the `127.0.0.1` IRC endpoint) and `https://localhost:4175`
(a foreign site, for the approval spec). On the
hosted web build, uploads to another network's file host are blocked by `connect-src`, like its
images (design 30); Tauri has no CSP.

## Testing

- Engine: `release_credential` over every credential, approval and site case (equal hosts, shared
  registrable domain, private suffixes, IP-like forms, single labels, punycode, case and trailing
  dots);
  `ResolveUpload` over a papo-testing wire for each resolution, the Basic header, remembered and
  forgotten approvals, and a changed host.
- Unit: the clipboard extractor (Firefox's synthetic paste cannot carry files, so this is its
  coverage); the uploader against a fake XHR (headers, progress, abort, every status, `Location`
  resolution, a redirected final URL); sniffing, the JPEG strip on a fixture with GPS EXIF, re-encode and shrink through a
  fake codec; the pipeline's approval, Bearer (including a failed token fetch) and retry paths; the composer's chip states.
- Playwright against local Ergo with the fake file host (`e2e/fake-filehost-server.mjs`), which
  accepts `POST /upload`, checks Basic, returns `201` with `Location`, and has slow, `413`, `415`
  and `429` modes. Chromium and WebKit synthesize a clipboard paste. Specs: chip and thumbnail;
  Enter uploads with progress and sends `caption URL`, which renders inline; remove; offline
  refusal; the `413` shrink retry; a network without a file host shows the note and keeps the paste;
  a foreign-site file host asks, and Remember skips the next prompt. `nativeFeelAudit` and the
  composer focus rules stay green. Screenshots: desktop light and dark, and phone.

## Out of scope

The Attach button and picker, drag-and-drop, several images, arbitrary files, an outbox for
offline sends, deleting uploads (the spec has none), and a native Tauri uploader.
