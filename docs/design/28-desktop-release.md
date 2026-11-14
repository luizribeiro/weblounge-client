# 28 — Desktop release

Status: signed off and built (Luiz, 2026-11-13). Distributes the design 27 wrapper to friends.

## Problem

The wrapper is ad-hoc signed, so it opens without warnings only on the Mac that built it. Friends
downloading it meet Gatekeeper's "cannot be opened" dialog, and Homebrew is phasing out installing
casks around quarantine (`--no-quarantine` is deprecated). Friends need a one-command install and
a way to receive new wrapper versions.

Updates matter less than they seem: the window loads `https://beta.weblounge.org`, so every web
deploy reaches every friend on reload. Only wrapper changes (menus, badge, notifications, the
shell identity) need a new app version, and those are rare.

## Approach

Sign with Luiz's Developer ID, notarize, and publish through his existing Homebrew tap.

```
brew install --cask luizribeiro/tap/weblounge     # install, and trust the tap's cask
brew upgrade                                       # later versions
```

The tap (`luizribeiro/homebrew-tap`) today holds source-built formulae bumped by a reusable
workflow on a `v*` tag. This adds a cask beside them, bumped the same way.

## Release flow

A release script, `apps/tauri/release/release.mjs` (run with `nix develop -c node`), runs on Luiz's
Mac, outside Nix: signing needs the login keychain's Developer ID identity and notarization needs
the network and the stored `notarytool` profile `weblounge`, neither of which the sandbox may have.
`--dry-run` stops before publishing and keeps the verified image.

1. Refuse to run unless the worktree is clean, `HEAD` is on `origin/main`, and the tag
   `desktop-v<version>` does not exist; `<version>` is the crate's, which `tauri.conf.json` and
   `Cargo.toml` must agree on.
2. `nix build .#desktop`, the same checked bundle as today (clippy, unit tests, Info.plist binding).
3. Copy it out of the store and re-sign it with `codesign --force --options runtime --timestamp`
   and the Developer ID Application identity. The identifier stays `org.weblounge.desktop`, so
   notification permission, web storage and the login item carry over from an ad-hoc install.
   The hardened runtime needs no entitlements: WebKit's JIT runs in its own signed processes.
4. Notarize a zip of the app and staple the ticket to the app itself, so a copy dragged out of the
   image or installed by the cask passes Gatekeeper on first launch without reaching Apple.
   Then build `weblounge-<version>.dmg` with `hdiutil` (compressed UDIF, the Applications symlink
   as in `.#desktop-dmg`), sign it, notarize it, and staple the ticket to the image. Notarization
   and stapling need a real UDIF image, which the sandboxed ISO hybrid of `.#desktop-dmg` is not;
   that package stays for local installs. A submission that Apple does not accept prints its
   notarization log and stops the release, keeping its files for inspection.
5. Verify before publishing: `spctl --assess --type open --context context:primary-signature` on
   the image, `spctl --assess --type execute` and `codesign --verify --strict --deep` on the
   mounted app, and `stapler validate`.
6. Create a GitHub release with the image, letting GitHub create the tag `desktop-v<version>` at
   the built commit in the same step, so a failed upload leaves no tag that would block a retry.

Publishing the release triggers a workflow in this repo that calls a new reusable `bump-cask`
workflow in the tap, the counterpart of `bump-formula`: it downloads the release's image, rewrites
the cask's `version` and `sha256`, and pushes. It uses a `HOMEBREW_TAP_TOKEN` secret, as clipsy
does.

## The cask

`Casks/weblounge.rb` in the tap installs `weblounge.app` from the release image, requires Apple
silicon (the only architecture built), and its `zap` removes the app's support, cache, WebKit and
preferences directories plus the Open at Login launch agent. It does not declare `auto_updates`,
so `brew upgrade` installs new versions.

## Out of scope

- In-app updates (Tauri's updater with a signed feed). Worth adding once wrapper changes are
  frequent or friends do not run `brew upgrade`; the cask then declares `auto_updates true`.
- Intel Macs (a universal build), Windows and Linux; friends there use the web app, which installs
  as a PWA with push.
- Building releases in GitHub Actions, which would need the signing certificate and an App Store
  Connect API key as secrets.

## Testing

- The script's preconditions and version check are a pure function with unit tests.
- The first release is checked by hand on a second macOS account with no prior install: install
  through the tap, launch without any Gatekeeper prompt, sign in, allow notifications, receive one,
  then release a patch version and confirm `brew upgrade` replaces the app with permission and
  sign-in intact.
