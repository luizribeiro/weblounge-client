import assert from "node:assert/strict";
import test from "node:test";
import {
  commitVersion,
  describeCommit,
  nextReleaseVersion,
  parseReleaseTag,
  releaseTag,
} from "./release-version.mjs";

const history = ["web-v0.1.0", "desktop-v0.1.3", "ios-v0.1.3+1412", "v0.2.0"];
const notReleases = [
  "web-v0.1.0",
  "desktop-v0.1.3",
  "v0.2",
  "v0.2.0-rc.1",
  "v1.2.3+4",
  "v01.2.0",
  "v1.2.03",
];

test("only vX.Y.Z tags are releases", () => {
  assert.deepEqual(parseReleaseTag("v0.2.0"), [0, 2, 0]);
  for (const tag of notReleases) assert.equal(parseReleaseTag(tag), undefined, tag);
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

const at = (commitsSinceTag, commitsTotal, tag = "v0.2.0") =>
  commitVersion({ tag, commitsSinceTag, commitsTotal });

test("a build at a release tag shows the release itself", () => {
  assert.deepEqual(at("0\n", "2697\n"), { version: "0.2.0", display: "0.2.0", build: "2697" });
});

test("a build after a release shows the commits since it and counts every commit as its build", () => {
  assert.deepEqual(at("14", "2711"), { version: "0.2.0", display: "0.2.0+14", build: "2711" });
});

test("a build described by an old tag line or by no tag is refused", () => {
  assert.throws(() => at("3", "2600", "desktop-v0.1.3"), /desktop-v0\.1\.3 is not a vX\.Y\.Z/);
  assert.throws(() => at("0", "1", ""), /is not a vX\.Y\.Z release tag/);
});

test("counts that are not commit counts are refused", () => {
  for (const since of ["-1", "abc"]) {
    assert.throws(() => at(since, "2711"), /count since the release .* is not a commit count/);
  }
  for (const total of ["0", "", "27a"]) {
    assert.throws(() => at("0", total), /build number .* is not a commit count/);
  }
});

function fakeGit(outputs) {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(" "));
    return outputs[calls.length - 1];
  };
  return { calls, git };
}

test("a commit is described by its nearest plain vX.Y.Z tag and its commit counts", () => {
  const commit = "d578b01f";
  const { calls, git } = fakeGit(["v0.2.0", "14", "2711"]);
  assert.deepEqual(describeCommit(commit, git), {
    version: "0.2.0",
    display: "0.2.0+14",
    build: "2711",
  });
  assert.deepEqual(calls, [
    `describe --tags --abbrev=0 --match v[0-9]*.[0-9]*.[0-9]* --exclude *[-+]* ${commit}`,
    `rev-list --count v0.2.0..${commit}`,
    `rev-list --count ${commit}`,
  ]);
});
