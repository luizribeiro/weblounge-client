import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = (name) =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));

// Tauri merges the platform file over the base one, then each --config file over that. Both keys
// are top-level strings, where a shallow assign agrees with Tauri's JSON merge patch.
const identity = (...names) => {
  const { productName, identifier } = Object.assign(
    {},
    ...names.map(config),
  );
  return { productName, identifier };
};

const identities = {
  desktopDev: identity("tauri.conf.json"),
  desktopRelease: identity("tauri.conf.json", "tauri.release.conf.json"),
  iosDev: identity("tauri.conf.json", "tauri.ios.conf.json"),
  iosRelease: identity(
    "tauri.conf.json",
    "tauri.ios.conf.json",
    "tauri.ios.release.conf.json",
  ),
};

test("the iOS dev and release builds carry the phone app's identifiers", () => {
  assert.deepEqual(identities.iosDev, {
    productName: "weblounge dev",
    identifier: "org.weblounge.ios.dev",
  });
  assert.deepEqual(identities.iosRelease, {
    productName: "weblounge",
    identifier: "org.weblounge.ios",
  });
});

test("no two identities share an identifier", () => {
  const identifiers = Object.values(identities).map(
    ({ identifier }) => identifier,
  );
  assert.equal(new Set(identifiers).size, identifiers.length);
});

test("the iOS app supports iOS 17 and later", () => {
  assert.equal(
    config("tauri.ios.conf.json").bundle.iOS.minimumSystemVersion,
    "17.0",
  );
});
