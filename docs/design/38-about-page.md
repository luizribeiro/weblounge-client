# 38 — About page

Status: scope set by Luiz (2026-11-16); the rest follows from designs 29 and 37.

## Problem

When something breaks, Luiz asks "which build are you on?" and the answer takes several steps:
`/version` in a composer, or `/debug viewport`, and neither says which channel or which native
shell the page runs in. There is no place a person can open, read the build, and paste it into a
DM.

## Decisions

1. **Where.** A third Settings section, **About**, after Appearance and Notifications, shown on
   every platform: the desktop modal (and its folded rail) and the phone Settings root. On the
   phone root its summary is the version ("68ea9a3"); the section-summary signature has no channel, and the page names it.
2. **What it shows** (Luiz: no more than this):
   - a big brand mark at the top: the chair glyph (`assets/chair.svg`, masked like the sidebar
     logo) in its tile, and the app name below it, which is `appTitle(channel)` from design 37
     ("weblounge" or "weblounge β");
   - **Version**, **Commit** (short), **Built** (UTC to the minute; "Development server" on the
     dev server), **Channel** (Beta or Release; app mode and the dev server are Release, as
     design 37 says), **Platform** ("Mac app 0.1.3" and "iOS app 0.1.3" from the shell identity,
     otherwise "Installed web app" or "Browser tab" from the existing `display` of
     `platformEnvironment()`);
   - a **Copy debug info** button, with a status line after it ("Copied" or "Couldn't copy").
3. **Version has one source.** `buildVersion.version`, set by one function in
   `build-version.ts`; `buildVersion.text` (`/version`, `window.weblounge`, the debug overlay) is
   built from it too. Today it is the short commit, so Version and Commit read the same, because the web version lives only in the
   `web-v…` tag (design 37) and the build does not see it. When the pending versioning decision
   lands (likely one shared vX.Y.Z, git-describe on beta), only that function changes; `/version`,
   the debug overlay and About all follow.
4. **Full commit.** The flake passes the full `self.rev` as `WEBLOUNGE_BUILD_SHA`; the page derives
   the short form (the first 7 characters, as `shortRev` gave) only from a 40-hex value; any other
   value (`dirty` without `self.rev`, `ci`, `dev`) is kept whole. One build input, two views. The
   e2e checks compare `ci` and the previous app's own short SHA, so they are unchanged.
5. **Native build number.** The shell publishes only its crate version (`CARGO_PKG_VERSION`) in
   `__WEBLOUNGE_SHELL__`; it has no build number today. Platform shows that version. Publishing the
   iOS `CFBundleVersion` would need a new native build (design 37), so it is left for later.
6. **Channel reaches the page through a context.** The page reads the channel once at startup
   (design 37) and provides it to the tree; About reads it. No second reading of the config.
7. **Existing diagnostics stay.** `/version`, `/debug viewport` and the other `/debug` overlays keep
   what they show; About does not absorb them.

## Copy format

Plain text, one `Label: value` per line, the same labels as the page, so it reads the same in a
DM:

```
weblounge debug info
Version: 68ea9a3
Commit: 68ea9a3c1f0e5b2d9a7c4e8f3b6d1a0c9e2f4b7a
Built: 2026-11-16 06:40 UTC
Channel: Beta
Platform: Mac app 0.1.3
User agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 …
```

The copy carries the full commit where the page shows the short one, and adds the user agent,
which the page omits as noise.

## Secrets

None of the fields is secret, and the builder takes only those fields: it has no access to the
session, the push subscription, relay ids or OAuth state, so nothing secret can reach the text.
A unit test pins the exact label set and checks that no token-shaped run (20 or more base64url
characters) appears outside the Commit value.

## Boundaries

- `build-version.ts` owns version, commit and build date; `hosted/release-channel.ts` owns the
  channel, its name and its context; `platform/host-shell.ts` owns the shell identity.
- `features/settings/about-facts.ts` turns those into the labelled facts and the copy text; the
  page renders the facts and copies the text. Neither formats a fact itself.
- Out of scope: push, session, server, engine and storage details (they stay in `/debug`), a
  native build number, an in-app changelog.

## Testing

- Unit: the fact list and copy text for a production build, the dev server, each platform; no
  token-shaped value; the short commit derived from a full one.
- Playwright, desktop and phone: open Settings → About, check the fields, press Copy debug info and
  read the clipboard (Chromium grants `clipboard-read` and `clipboard-write` to the context). The existing build-version, settings, settings-rail and settings-phone specs
  keep passing.
