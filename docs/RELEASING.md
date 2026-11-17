# Releasing weblounge

The one operational guide for shipping the web app, the macOS app and the iOS app. The reasons
behind each rule are in the designs; this page says what to do.

- [Design 37, release channels](design/37-release-channels.md): channels, version scheme, the cut
  script, how builds learn their version.
- [Design 28, desktop release](design/28-desktop-release.md): macOS signing, notarization, the
  Homebrew cask.
- [Design 33, iOS through TestFlight](design/33-ios-testflight.md): App Store Connect, signing,
  the IPA checks, the push relay's APNs setup.
- [Design 36, push notifications switch](design/36-push-settings.md): what each device registers
  for push, which a native build changes.

## Channels

| Channel | Where | What it runs | Shows |
| --- | --- | --- | --- |
| Release | irc.weblounge.org | the commit of a `vX.Y.Z` tag Luiz cut; live at v0.2.0 (64b912c4), replacing gamja | weblounge, version `0.2.0` |
| Beta | beta.weblounge.org | every green main commit | weblounge β, version `0.2.0+14` |
| TestFlight iOS app | iPhone | a native shell that loads beta.weblounge.org | weblounge, felt-green icon |
| Homebrew macOS app | `brew install --cask luizribeiro/tap/weblounge` | a native shell that loads beta.weblounge.org | weblounge, felt-green icon |
| Dev | local Mac builds only | a native shell that loads beta.weblounge.org | weblounge dev, yellow icon |

The page learns its channel from the deployment's `/config.json`: the server serves
`"channel": "beta"` on beta.weblounge.org and `"release"` (or nothing) on irc.weblounge.org.

The push relay (push.weblounge.org) builds from the beta pin, never the release pin, so it is at
least as new as every client that talks to it.

## Versions

One release line, `vX.Y.Z`, shared by web, macOS and iOS. Only Luiz cuts these tags. The old
`web-v0.1.0` and `desktop-v0.1.0`..`desktop-v0.1.3` tags are history; nothing creates `web-v`,
`desktop-v` or `ios-v` tags again.

| Build | Shown version | Example |
| --- | --- | --- |
| irc.weblounge.org | the tag | `0.2.0` |
| beta.weblounge.org, 14 commits after v0.2.0 | tag + commits since | `0.2.0+14` |
| Native About line | page, then app | `0.2.0+14 · app 0.2.0+3` |
| CI and local web builds | none (sha and build time only) | |
| Local native builds | `dev` | |

Native bundles:

| Field | Value | Example |
| --- | --- | --- |
| CFBundleShortVersionString, Homebrew cask version | last release tag | `0.2.0` |
| CFBundleVersion (build number) | `git rev-list --count` of the built commit | `2711` |

Print any commit's version with `node apps/tauri/release/describe-version.mjs <commit>`. Bumps: the
cut defaults to minor (`0.2.0` → `0.3.0`); `--patch` gives `0.2.1`, `--major` `1.0.0`.

## Cutting a release

From a clean checkout of main whose CI is green. Each step is a dry run until told otherwise.

1. **Tag (Luiz).** `node app/scripts/cut-web-release.mjs [--patch|--major]` prints the tag, the
   commit, the commands and the server pin, and refuses on a dirty tree, `HEAD` other than
   `origin/main`, an existing tag, or CI that is not a completed success. Run it again with
   `--execute` to create and push the tag. Despite its name, the tag is the shared release.
2. **irc.weblounge.org (server session, `~/weblounge`).** Set the release client pin to the
   printed `rev` and `version` (`clientPackages.app.withVersion version`) and deploy with Luiz's
   OK. The release pin is always a tag's own commit, so its version has no `+N`.
3. **Homebrew macOS app (Mac session, only when needed; see "When native builds are needed").**
   On the weblounge-desktop Mac, at `origin/main`:
   `nix develop -c node apps/tauri/release/release.mjs --dry-run`, then without `--dry-run`. It
   builds `.#desktop` with the last tag as its short version and the commit count as its build,
   signs, notarizes and staples the app and the image, and creates the GitHub release of `vX.Y.Z`
   on the existing tag with `weblounge-X.Y.Z.dmg`. `desktop-release.yml` then bumps the cask. It
   refuses if that GitHub release already exists: one macOS build per release tag.
4. **TestFlight (Mac session, only when needed).**
   `nix develop -c node apps/tauri/release/release-ios.mjs --dry-run`, then without
   `--dry-run`. It builds the IPA with the last tag as its short version and the commit count as
   its build, checks it, runs `altool --validate-app` and uploads. It creates no tag. App Store
   Connect refuses a build number it has seen, so a retry needs a new commit on main.

## Beta

Beta follows main and needs no tag:

1. Main is green in GitHub Actions.
2. The server session moves the beta client pin to that commit, with its version from
   `describe-version.mjs`, and the push relay with it.
3. It deploys under Luiz's standing go for beta. Changes to the service worker or notification
   code still need his OK typed in the server session.

The native apps pick the new page up on their next load; no native build is involved.

## When native builds are needed

A new TestFlight or Homebrew build is needed only when app-built code changes:

- `apps/tauri/` (the shell, its Tauri configs, capabilities, icons, `gen/apple` with Info.plist,
  entitlements and the notification extension)
- `crates/native-bridge/`
- `crates/push-payload/` (the iOS notification extension links it)

Anything else, the page included, reaches the native apps through beta.weblounge.org.

## Compatibility rules

Decided with the version scheme (2026-11-17). The capability lists, floors, banner and snapshot
tests are not built yet; until they are, a native change that the page depends on must keep the
page working on older shells by hand.

- **Capabilities, not versions.** The shell advertises the commands and events it has; the page
  calls only those and falls back otherwise. Page listeners must work when an older shell never
  sends an event.
- **Additive-only contracts** between things that deploy separately: the native bridge, App Group
  records, the APNs payload, relay `/v1` and `config.json`. To change a shape, ship readers
  first and write both shapes until the floor passes the last old reader. Snapshot tests guard
  these.
- **Floors.** The page carries `MIN_SHELL`; `config.json`'s `client.min_shell` can raise it with
  no deploy. Below the floor the page shows an "Update the app" banner (TestFlight, or
  `brew upgrade --cask weblounge`). Only a shell below a security floor is blocked outright.
- **Support window.** Every page and server supports native builds up to 90 days old; raise a
  floor past a build only once its successor has been out 90 days.

## Rollback

Roll forward only, on every channel, the irc.weblounge.org pin included: fix with a revert commit
and ship it as a new beta deploy or a new tag. An older page cannot open a newer IndexedDB and
settings records refuse newer versions, so moving a pin back is not a rollback.

## Who does what

| Who | Does |
| --- | --- |
| Luiz | Cuts `vX.Y.Z` tags; OKs irc.weblounge.org deploys and service-worker or notification deploys; signs in to Xcode and owns the Apple accounts and keys |
| Client session (`~/weblounge-client`) | Lands code on main with green CI; keeps the release scripts, designs and this guide; never pushes tags |
| Server session (`~/weblounge`) | Bumps the beta and release client pins with their versions, the push relay, `config.json` floors; deploys |
| Mac session (weblounge-desktop) | Runs `release.mjs` and `release-ios.mjs`; checks Mac-only builds and devices |

## Credentials

Names and locations only; never copy a value into the repo or a session.

| What | Where | Used by |
| --- | --- | --- |
| App Store Connect API key | `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID` and `~/.appstoreconnect/private_keys/AuthKey_<key id>.p8` on the Mac | `release-ios.mjs` (`altool`) |
| APNs auth key (`.p8`) | sops secret `push-relay-apns-key` in `~/weblounge`, with key id, team id and topics in `services/push-relay.nix` | the push relay |
| Developer ID Application identity (its name is fixed in `release.mjs`) | the Mac's login keychain | `release.mjs` (codesign) |
| Notarization profile `weblounge` | the Mac's keychain (`notarytool store-credentials`) | `release.mjs` |
| Apple Distribution certificate and profiles | Xcode automatic signing with Luiz's team, login keychain | `release-ios.mjs` |
| `HOMEBREW_TAP_TOKEN` | GitHub Actions secret on this repo | `desktop-release.yml` cask bump |

## Known pitfalls

- **Xcode must be signed in.** Automatic signing (design 33) needs Luiz's Apple account added in
  Xcode → Settings → Accounts, which creates the Apple Distribution certificate and profiles; the
  Mac had no signed-in account at first, so the signed iOS build could not be made.
- **App Store validation.** 90207: the app must not hold an empty folder (Tauri's
  `gen/apple/assets` held only `bundle.resources`). 90360: the notification extension needs
  `CFBundleDisplayName`. `release-ios.mjs` checks both before uploading.
- **altool under the dev shell.** Run inside `nix develop` with its `DEVELOPER_DIR` and `SDKROOT`,
  `altool --validate-app` reports a valid IPA as 90207 "does not contain a bundle executable";
  `release-ios.mjs` runs it with the build's Xcode environment, as it does the build.
- **The desktop fileset guard.** `nix/desktop.nix` lists every file the macOS build and its tests
  read. A new file under `apps/tauri/release/` that a listed module imports, or a new
  `*.test.mjs` there, must be added to it. Linux CI's `desktop-source` check only runs
  `cargo metadata` on the fileset, so it catches a missing crate path; a missing script fails
  only in the Mac's build.
