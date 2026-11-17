import assert from "node:assert/strict";
import test from "node:test";
import { buildNumber, iosReleaseTag, staleBuild, unshippableVersion } from "./ios-plan.mjs";

test("names the tag after the version and the build", () => {
  assert.equal(iosReleaseTag("0.1.3", "2620"), "ios-v0.1.3+2620");
});

test("the build number is the commit count", () => {
  assert.equal(buildNumber("2620\n"), "2620");
});

test("a commit count that is not a positive number is no build number", () => {
  for (const count of ["", "0", "-3", "12a", "fatal: bad revision"]) {
    assert.throws(() => buildNumber(count), /is not a build number/);
  }
});

const tags = ["desktop-v0.1.3", "ios-v0.1.2+2580", "ios-v0.1.3+2600", "v0.1.0"];

test("a build above every uploaded one is fresh", () => {
  assert.equal(staleBuild({ tags, build: "2620" }), false);
  assert.equal(staleBuild({ tags: ["desktop-v0.1.3"], build: "1" }), false);
});

test("a build at or below an uploaded one is stale, whatever the version", () => {
  assert.equal(
    staleBuild({ tags, build: "2600" }),
    "build 2600 is not above the last uploaded build 2600; release from origin/main",
  );
  assert.match(staleBuild({ tags: ["ios-v0.0.9+3000"], build: "2620" }), /last uploaded build 3000/);
});

test("tags that name no uploaded build are ignored", () => {
  assert.equal(
    staleBuild({ tags: ["ios-v0.1.3", "ios-v0.1.3+abc", "desktop-v0.1.3+9999"], build: "1" }),
    false,
  );
});

test("only plain integer versions ship to App Store Connect", () => {
  for (const version of ["0.1.3", "1.0", "2"]) assert.equal(unshippableVersion(version), false);
  for (const version of ["0.1.3-beta.1", "0.1.3.4", "v0.1.3"]) {
    assert.match(unshippableVersion(version), /is not an App Store version/);
  }
});
