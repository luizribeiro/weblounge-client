import assert from "node:assert/strict";
import test from "node:test";
import { nextReleaseVersion, parseReleaseTag, releaseTag } from "./release-version.mjs";

const history = ["web-v0.1.0", "desktop-v0.1.3", "ios-v0.1.3+1412", "v0.2.0"];
const notReleases = ["web-v0.1.0", "desktop-v0.1.3", "v0.2", "v0.2.0-rc.1", "v01.2.0", "v1.2.03"];

test("only vX.Y.Z tags are releases", () => {
  assert.deepEqual(parseReleaseTag("v0.2.0"), [0, 2, 0]);
  for (const tag of [...notReleases, "v1.2.3+4"]) {
    assert.equal(parseReleaseTag(tag), undefined, tag);
  }
  assert.equal(releaseTag("0.3.0"), "v0.3.0");
});

test("the next release bumps the highest release tag, ignoring the old tag lines", () => {
  assert.equal(nextReleaseVersion(history, "minor"), "0.3.0");
  assert.equal(nextReleaseVersion(history, "patch"), "0.2.1");
  assert.equal(nextReleaseVersion(history, "major"), "1.0.0");
});

test("release tags compare numerically", () => {
  assert.equal(nextReleaseVersion(["v0.9.0", "v0.10.0", "v0.2.7"], "patch"), "0.10.1");
});

test("without a release tag there is nothing to bump", () => {
  assert.throws(
    () => nextReleaseVersion(["web-v0.1.0", "desktop-v0.1.3"], "minor"),
    /no vX\.Y\.Z release tag/,
  );
});

test("an unknown bump is refused", () => {
  assert.throws(() => nextReleaseVersion(history, "pre"), /unknown bump pre/);
});
