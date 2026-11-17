# 37 — Release channels

Status: channels and version scheme (option A) decided by Luiz (2026-11-17); the mechanism below
follows from them.
Extends design 28 (desktop release) and design 33 (TestFlight).

## Problem

There is one web deployment, beta.weblounge.org, and it runs every green main commit.
irc.weblounge.org still serves gamja. Luiz wants our client there too, but on a build he picked,
not on whatever main is. The page cannot tell the two apart, so a beta tab looks exactly like a
release tab, and nothing says how a web release is cut or when a new TestFlight build is due.

## Decisions (Luiz, 2026-11-17)

| Channel | Where | What it runs | Name |
| --- | --- | --- | --- |
| Release | irc.weblounge.org (gamja removed) | a web release tag Luiz cuts by hand | weblounge |
| Beta | beta.weblounge.org | every green main commit, deployed as today | weblounge β |
| Native | TestFlight iOS app, Homebrew macOS app | loads beta.weblounge.org | weblounge, felt-green icon |
| Dev | local Mac builds only | loads beta.weblounge.org | weblounge dev, yellow icon |

- The first web release is cut from current main.
- irc.weblounge.org signs in with the same concierge client, `client_id` `weblounge-client`, and
  `redirect_uri` `https://irc.weblounge.org/`.
- A later App Store build may load irc.weblounge.org; that is out of scope here.

## How the page learns its channel

The deployment's `/config.json` (decoded in `app/src/hosted/deployment-config.ts`, typed by the
engine's `DeploymentConfig`) gains a top-level, optional `channel` on hosted configs:

```json
{ "mode": "hosted", "channel": "beta", "network": { … }, "oauth": { … } }
```

- Values are `"beta"` or `"release"`; anything else is a config error, like every other field.
- Absent means `"release"`. A host that forgets the field shows the plain name, which is the safe
  failure: a release page never claims to be beta.
- The server sets it per vhost: `"beta"` on beta.weblounge.org, `"release"` (or nothing) on
  irc.weblounge.org.
- `{"mode":"app"}` has no channel; self-hosted app mode is always release.
- The field is added to the engine's Rust `DeploymentConfig::Hosted` (a `ReleaseChannel` enum) so
  the generated TS type carries it, and to the decoder's known hosted fields.

Why config and not the hostname: the page already trusts this file for everything else that
differs per deployment, the e2e suite already serves it, other hosts (local, staging, another
network) need no hostname table, and the server owns which vhost is which.

The channel is read once at startup from the config the page starts with. That is often the
cached copy, which `loadDeploymentConfig` revalidates in the background: a changed channel (or the
first config to carry one, since a cached pre-channel config reads as release) shows from the next
load. Channels do not flip in place.

**What changes on beta:** the document title's base is "weblounge β" instead of "weblounge", so
the browser tab and an installed PWA's window say "weblounge β", and the unread prefix becomes
"(3) weblounge β". The native apps keep their own window and app names ("weblounge"), because a
WKWebView's `document.title` is not shown. The sidebar and phone header wordmark stay
"weblounge" (not asked for; see open questions).

## Versions and tags (Luiz, 2026-11-17, option A)

This replaces the separate `web-v`, `desktop-v` and `ios-v` lines, design 28's tag and design 33's
decision 9. The commit-count proposal (`~/docs/weblounge/versioning.md`) was rejected for its big
numbers; its compatibility rules (capabilities, floors, additive contracts, roll forward, 90 days)
are kept and summarised in `docs/RELEASING.md`.

- **One release line, `vX.Y.Z`,** shared by web, macOS and iOS. Only Luiz cuts these tags, with
  the cut script below. The first is `v0.2.0` on 64b912c4, the irc.weblounge.org pin.
- The old tags `web-v0.1.0` and `desktop-v0.1.0`..`desktop-v0.1.3` stay as history. Nothing
  creates `web-v`, `desktop-v` or `ios-v` tags again.
- **Displayed versions are git-describe style:** a build at a release tag shows `0.2.0`; a build
  14 commits after it shows `0.2.0+14`. Beta pages and native builds usually carry the `+N`. The
  native About line shows both builds in this form, page first: `0.2.0+14 · app 0.2.0+3`. The
  native build number below is a separate, larger number shown only beside it.
- **Native bundle versions:** CFBundleShortVersionString and the Homebrew cask version are the
  last release (`0.2.0`). CFBundleVersion, the build number, is the commit count of the built
  commit (`git rev-list --count`), which only grows on a linear main; it is shown only in About
  and debug info.
- No file in the tree carries the version. `Cargo.toml` and `tauri.conf.json` keep a placeholder
  that the release scripts override, and nothing displays `CARGO_PKG_VERSION`.

### How a build learns its version

The version needs the last `v` tag and the commit count since it. Nix sees neither: a flake's
source has no `.git`, and `github:` inputs carry no tags and no `revCount` (a `git+https` input adds
`revCount`, which is the total count, still without tags). So the version is computed from git
**outside** the build and passed in:

- **One computation:** `describeCommit` in `apps/tauri/release/release-version.mjs` finds the
  nearest plain `vX.Y.Z` tag (`git describe --tags --abbrev=0`, matching `v[0-9]*.[0-9]*.[0-9]*`
  and skipping tags with `-` or `+`) and the counts `git rev-list --count <tag>..<commit>` and
  `<commit>`, and `commitVersion` turns them into the short version, the displayed `X.Y.Z` or
  `X.Y.Z+N` and the build number. `node apps/tauri/release/describe-version.mjs <commit>` prints
  the displayed version after fetching tags.
- **Web:** the Vite build reads `WEBLOUNGE_VERSION` and defines it as `__BUILD_VERSION__`
  (`null` when unset). The flake's `app` stays version-free, so CI and local builds carry none,
  and offers `app.withVersion "<version>"`. The page's `versionFor` (design 38) shows it.
- **Server:** each client pin (beta, release) is kept together with its version, for example
  `{ rev = "<sha>"; version = "0.2.0+14"; }`, and builds `clientPackages.app.withVersion version`.
  The pin bump runs `describe-version.mjs <sha>` in a client checkout and writes both at once.
  The `github:` input stays; no `git+https` input is needed.
- **Native:** both release scripts take the short version, the displayed version and the build
  number from the one commit they build (`HEAD`, which must be `origin/main`), so they cannot
  disagree. `crateVersion` and the `desktop-v`/`ios-v` tag helpers go away.
- **iOS:** `release-ios.mjs` builds outside the Nix sandbox, so it passes the versions straight to
  the build: the short version to agvtool (both bundles), the build number in Tauri's `--config`,
  and `WEBLOUNGE_VERSION` in the build's environment.
- **macOS:** `release.mjs` builds `.#desktop` through `override { version = { marketing, build,
  display }; }`, which adds a Tauri `--config` for `version` and `bundle.macOS.bundleVersion` and
  sets `WEBLOUNGE_VERSION`.
- **Shell identity:** `shell.rs` publishes `WEBLOUNGE_VERSION` as `__WEBLOUNGE_SHELL__.version`,
  or `"dev"` for a build that was not given one.

## Cutting a web release

`node app/scripts/cut-web-release.mjs [--patch|--major] [--execute]` from a checkout of main:

1. Fetches `origin/main` and tags (`gitState`). Refuses when the tree is dirty, `HEAD` is not
   `origin/main`, the tag exists, or the `CI` check run on `HEAD` is not a completed success
   (pending, failed and missing all refuse).
2. Bumps the highest `vX.Y.Z` tag: minor by default (`0.2.0` → `0.3.0`), or `--patch` (`0.2.1`)
   or `--major` (`1.0.0`).
3. Prints the tag, the commit, the exact `git tag -a` and `git push origin <tag>` commands, and
   the server pin for irc.weblounge.org: the commit and its version (`0.3.0`).
4. Creates and pushes the tag only with `--execute`. Without it, it changes nothing.

The server then moves irc.weblounge.org's client pin to that commit and version and deploys. The
release pin is always a tag's own commit, so it shows `0.3.0` with no `+N`. Beta keeps following
main and from then on shows `0.3.0+N`.

The script keeps its name, but the tag it cuts is the shared release: a native fix that needs a
new short version (see below) is cut the same way, and irc.weblounge.org moves to it only when the
server pin is bumped.

## Native releases

- `release.mjs` (macOS) and `release-ios.mjs` (TestFlight) build from `origin/main`'s `HEAD`,
  which need not be a release tag. Neither creates a tag.
- macOS publishes the GitHub release of the last tag, `vX.Y.Z`, on that existing tag
  (`--verify-tag`), carrying `weblounge-X.Y.Z.dmg`; `desktop-release.yml` bumps the cask from it.
  Because the cask version is `X.Y.Z`, there is one macOS build per release tag: the script
  refuses when that GitHub release already exists, and a fix needs a new (patch) tag.
- iOS uploads build `N` with short version `X.Y.Z`. App Store Connect refuses a reused build
  number in `validate-app`, which both the dry run and the release run before uploading; a retry
  needs a new commit on main.

## When a new TestFlight build is needed

Only when app-built code changes: `apps/tauri/`, `crates/native-bridge/`, `crates/push-payload/`
(the NSE links it), the app icons, Info.plist and capabilities. A page or JS-only change reaches
the native apps through beta.weblounge.org with no new build. The same rule applies to the
Homebrew macOS app.

## Boundaries

- The config decoder owns the field and its default; one helper turns a config into a channel and
  a channel into the app title. No hostname checks anywhere.
- The cut script reuses `apps/tauri/release/shell.mjs` (`gitState`, `run`) and `plan.mjs`'s
  `blockers` (tree, `HEAD`, tag), adding the CI check beside them in its own pure planning module
  (`app/scripts/web-release-plan.mjs`). Those helpers are not desktop-specific; they stay where
  they are rather than move for one more caller.
- The version tags above replace design 28's `desktop-v` tag and design 33's `ios-v` tag and
  decision 9; their build, signing and upload steps are unchanged.
- Out of scope: the server's vhost and pinning (the server repo), a channel badge in the sidebar,
  an App Store build loading irc.weblounge.org, automated web release notes.

## Testing

- Unit: the decoder accepts `"beta"` and `"release"`, rejects other values, and treats absent as
  release; the title helper; the cut plan (version bumps, tag, blockers including every CI state,
  printed commands, `--execute` gating); `commitVersion` at, after and with no release tag; the
  native plans' versions, build numbers and Tauri `--config`.
- Mac-only (Luiz's Mac session): a dry run of each native script shows the expected short version,
  build number and shell `version`.
- Playwright: a hosted spec serving `"channel": "beta"` sees the tab title "weblounge β"; the
  existing hosted specs (no channel) keep "weblounge".

## Open questions

1. Should the sidebar or phone wordmark also say β on beta? Today only the title does.
2. Does the push relay build from the beta pin or the release pin? The server session has asked
   Luiz.
3. One macOS build per release tag follows from the cask version being `X.Y.Z`. If Luiz wants
   macOS builds between tags, the cask version needs the build number too (`0.2.0,2711`).
