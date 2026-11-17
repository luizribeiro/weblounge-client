# 37 — Release channels

Status: channels decided by Luiz (2026-11-17); the mechanism below follows from them.
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

## Web release tags

- Format `web-v<semver>`, e.g. `web-v0.1.0`, beside `desktop-v…` and `ios-v…+…`.
- Web has its own version line. Native versions move only when app-built code changes (below),
  while web releases follow page changes; sharing one number would force bumps on one side for
  changes on the other. The web version lives only in the tag: no file in the tree carries it.
- The first release is `web-v0.1.0`. Later cuts default to the next patch; `--minor` and
  `--major` bump those parts.

## Cutting a web release

`node app/scripts/cut-web-release.mjs` from a checkout of main:

1. Fetches `origin/main` and tags (`gitState`). Refuses when the tree is dirty, `HEAD` is not `origin/main`,
   the tag exists, or the `CI` check run on `HEAD` is not a completed success (pending, failed
   and missing all refuse).
2. Prints the tag, the commit, the exact `git tag -a` and `git push origin <tag>` commands, and
   the server pin: the flake input URL `github:luizribeiro/weblounge-client/<commit>` (and the
   tag form) for irc.weblounge.org's client input.
3. Creates and pushes the tag only with `--execute`. Without it, it changes nothing.

The server then moves irc.weblounge.org's client input to that commit and deploys; beta keeps
following main.

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
- Designs 28 and 33 are unchanged: their tags, versions and scripts stay as they are.
- Out of scope: the server's vhost and pinning (the server repo), a channel badge in the sidebar,
  an App Store build loading irc.weblounge.org, automated web release notes.

## Testing

- Unit: the decoder accepts `"beta"` and `"release"`, rejects other values, and treats absent as
  release; the title helper; the cut plan (version bumps, tag, blockers including every CI state,
  printed commands, `--execute` gating).
- Playwright: a hosted spec serving `"channel": "beta"` sees the tab title "weblounge β"; the
  existing hosted specs (no channel) keep "weblounge".

## Open questions

1. Should the sidebar or phone wordmark also say β on beta? Today only the title does.
