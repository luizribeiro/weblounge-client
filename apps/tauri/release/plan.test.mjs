import assert from "node:assert/strict";
import test from "node:test";
import { blockers, imageName, releaseTag, releaseVersion } from "./plan.mjs";

const cargoToml = (version) => `[package]
name = "weblounge-desktop"
version = "${version}"
edition = "2024"

[dependencies]
serde = { version = "1", features = ["derive"] }
`;
const tauriConf = (version) =>
  JSON.stringify({ productName: "weblounge", version, identifier: "org.weblounge.desktop" });

test("the release version is the crate's when the bundle agrees", () => {
  assert.equal(
    releaseVersion({ cargoToml: cargoToml("0.2.1"), tauriConf: tauriConf("0.2.1") }),
    "0.2.1",
  );
});

test("a crate and bundle that disagree refuse to release", () => {
  assert.throws(
    () => releaseVersion({ cargoToml: cargoToml("0.2.1"), tauriConf: tauriConf("0.2.0") }),
    /Cargo.toml \(0.2.1\) and tauri.conf.json \(0.2.0\)/,
  );
});

test("dependency versions are not mistaken for the crate's", () => {
  assert.throws(
    () =>
      releaseVersion({
        cargoToml: 'serde = { version = "1" }\n',
        tauriConf: tauriConf("1"),
      }),
    /Cargo.toml \(undefined\)/,
  );
});

test("a package that inherits its version from a workspace refuses to release", () => {
  assert.throws(
    () =>
      releaseVersion({
        cargoToml: '[package]\nname = "weblounge-desktop"\nversion.workspace = true\n',
        tauriConf: tauriConf("0.1.0"),
      }),
    /Cargo.toml \(undefined\)/,
  );
});

test("names the tag and image after the version", () => {
  assert.equal(releaseTag("0.1.0"), "desktop-v0.1.0");
  assert.equal(imageName("0.1.0"), "weblounge-0.1.0.dmg");
});

const ready = {
  status: "",
  head: "b830efb5",
  originMain: "b830efb5",
  tags: ["v0.1.0", "desktop-v0.0.9"],
  version: "0.1.0",
};

test("a clean main at a new version can release", () => {
  assert.deepEqual(blockers(ready), []);
});

test("reports every reason a release cannot start", () => {
  assert.deepEqual(
    blockers({
      ...ready,
      status: " M apps/tauri/src/main.rs\n",
      head: "765844c8",
      tags: [...ready.tags, "desktop-v0.1.0"],
    }),
    [
      "the worktree has uncommitted changes",
      "HEAD is not origin/main",
      "desktop-v0.1.0 already exists; bump the version first",
    ],
  );
});
