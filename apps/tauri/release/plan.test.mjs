import assert from "node:assert/strict";
import test from "node:test";
import {
  blockers,
  desktopBuildArgs,
  foreignLibraries,
  imageName,
  publishedBlocker,
} from "./plan.mjs";

test("names the image after the release version", () => {
  assert.equal(imageName("0.2.0"), "weblounge-0.2.0.dmg");
});

test("builds the locked commit's desktop package with the release's versions", () => {
  const head = "d578b01f1c2e3d4c5b6a79881726354433221100";
  assert.deepEqual(
    desktopBuildArgs({
      repo: "/Users/luiz/weblounge-client",
      head,
      system: "aarch64-darwin",
      version: "0.2.0",
      build: "2711",
      display: "0.2.0+3",
    }),
    [
      "build",
      "--no-link",
      "--print-out-paths",
      "--expr",
      `(builtins.getFlake "git+file:///Users/luiz/weblounge-client?rev=${head}")` +
        ".packages.aarch64-darwin.desktop" +
        '.override { version = { marketing = "0.2.0"; build = "2711"; display = "0.2.0+3"; }; }',
    ],
  );
});

test("a release tag already carrying a macOS build refuses another", () => {
  assert.equal(publishedBlocker("v0.2.0", false), false);
  assert.match(
    publishedBlocker("v0.2.0", true),
    /GitHub release v0\.2\.0 already exists: one macOS build per release tag/,
  );
});

const ready = {
  status: "",
  head: "b830efb5",
  originMain: "b830efb5",
  tags: ["v0.2.0", "desktop-v0.1.3"],
  tag: "v0.3.0",
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
      tags: [...ready.tags, "v0.3.0"],
    }),
    [
      "the worktree has uncommitted changes",
      "HEAD is not origin/main",
      "v0.3.0 already exists",
    ],
  );
});

test("a release that creates no tag is held back only by the tree and HEAD", () => {
  const untagged = { status: "", head: "b830efb5", originMain: "b830efb5", tags: ["v0.2.0"] };
  assert.deepEqual(blockers(untagged), []);
  assert.deepEqual(blockers({ ...untagged, head: "765844c8" }), ["HEAD is not origin/main"]);
});

const otool =(...libraries) =>
  [
    "/Volumes/weblounge/weblounge.app/Contents/MacOS/weblounge-desktop:",
    ...libraries.map((path) => `\t${path} (compatibility version 1.0.0, current version 1.0.0)`),
  ].join("\n");

test("an app linking only macOS libraries has nothing foreign", () => {
  assert.deepEqual(
    foreignLibraries(
      otool(
        "/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit",
        "/usr/lib/libiconv.2.dylib",
        "/usr/lib/libSystem.B.dylib",
      ),
    ),
    [],
  );
});

test("reports libraries that other Macs do not have", () => {
  assert.deepEqual(
    foreignLibraries(
      otool(
        "/usr/lib/libSystem.B.dylib",
        "/nix/store/jaixg82zxmqjbn2s6grpd31jq0yygzc1-libiconv-115.100.1/lib/libiconv.2.dylib",
        "/opt/homebrew/lib/libssl.3.dylib",
      ),
    ),
    [
      "/nix/store/jaixg82zxmqjbn2s6grpd31jq0yygzc1-libiconv-115.100.1/lib/libiconv.2.dylib",
      "/opt/homebrew/lib/libssl.3.dylib",
    ],
  );
});

test("the binary's own path on the first line is not a library", () => {
  assert.deepEqual(foreignLibraries(otool()), []);
});

test("per-architecture headers of a universal binary are not libraries", () => {
  const binary = "/Volumes/weblounge/weblounge.app/Contents/MacOS/weblounge-desktop";
  const library = "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)";
  assert.deepEqual(
    foreignLibraries(
      [`${binary} (architecture x86_64):`, library, `${binary} (architecture arm64):`, library].join(
        "\n",
      ),
    ),
    [],
  );
});
