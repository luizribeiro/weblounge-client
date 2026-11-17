import assert from "node:assert/strict";
import test from "node:test";
import {
  ciBlocker,
  cut,
  describePlan,
  nextWebVersion,
  parseArguments,
  shellCommand,
  webReleasePlan,
} from "./web-release-plan.mjs";

const commit = "66f1c2ca0d9a4b7e8f1a2b3c4d5e6f708192a3b4";
const nativeTags = ["desktop-v0.1.2", "desktop-v0.1.3", "ios-v0.1.3+1412"];
const green = [{ name: "CI", status: "completed", conclusion: "success" }];
const cleanMain = {
  status: "",
  head: commit,
  originMain: commit,
  tags: nativeTags,
};

test("the first web release is 0.1.0 whatever the native versions are", () => {
  assert.equal(nextWebVersion(nativeTags, "patch"), "0.1.0");
  assert.equal(nextWebVersion([], "major"), "0.1.0");
});

test("later releases bump the highest web tag, compared numerically", () => {
  const tags = [
    ...nativeTags,
    "web-v0.1.9",
    "web-v0.1.10",
    "web-v0.1.2",
    "web-vnext",
  ];
  assert.equal(nextWebVersion(tags, "patch"), "0.1.11");
  assert.equal(nextWebVersion(tags, "minor"), "0.2.0");
  assert.equal(nextWebVersion(tags, "major"), "1.0.0");
});

test("arguments default to a patch dry run", () => {
  assert.deepEqual(parseArguments([]), { bump: "patch", execute: false });
  assert.deepEqual(parseArguments(["--minor", "--execute"]), {
    bump: "minor",
    execute: true,
  });
  assert.deepEqual(parseArguments(["--major"]), {
    bump: "major",
    execute: false,
  });
  assert.throws(
    () => parseArguments(["--dry-run"]),
    /unknown argument --dry-run/,
  );
  assert.throws(() => parseArguments(["patch"]), /unknown argument patch/);
});

test("only a completed, successful CI check lets the release through", () => {
  assert.equal(ciBlocker(green, commit), false);
  assert.match(ciBlocker([], commit), /CI has not run/);
  assert.match(
    ciBlocker(
      [{ name: "build", status: "completed", conclusion: "success" }],
      commit,
    ),
    /CI has not run/,
  );
  assert.match(
    ciBlocker(
      [{ name: "CI", status: "in_progress", conclusion: null }],
      commit,
    ),
    /CI is still running/,
  );
  assert.match(
    ciBlocker(
      [{ name: "CI", status: "completed", conclusion: "failure" }],
      commit,
    ),
    /CI ended failure/,
  );
  assert.match(
    ciBlocker(new Error("gh: HTTP 401: Bad credentials"), commit),
    /could not read CI for .*: gh: HTTP 401: Bad credentials/,
  );
});

test("a clean, green main plans the tag, its commands and the server pin", () => {
  const plan = webReleasePlan({
    git: cleanMain,
    checkRuns: green,
    bump: "patch",
  });
  assert.equal(plan.tag, "web-v0.1.0");
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.commands.map(shellCommand), [
    `git tag -a web-v0.1.0 ${commit} -m 'weblounge web 0.1.0'`,
    "git push origin web-v0.1.0",
  ]);
  assert.deepEqual(plan.pin, {
    tag: "web-v0.1.0",
    commit,
    flake: `github:luizribeiro/weblounge-client/${commit}`,
    flakeByTag: "github:luizribeiro/weblounge-client/web-v0.1.0",
  });
  const described = describePlan(plan);
  assert.match(described, /git push origin web-v0\.1\.0/);
  assert.doesNotMatch(described, /blocked:/);
});

test("every unmet precondition is listed at once", () => {
  const plan = webReleasePlan({
    git: {
      status: " M app/src/App.tsx",
      head: commit,
      originMain: "0".repeat(40),
      tags: ["web-v0.1.0"],
    },
    checkRuns: undefined,
    bump: "patch",
  });
  assert.equal(plan.tag, "web-v0.1.1");
  assert.deepEqual(plan.blockers, [
    "the worktree has uncommitted changes",
    "HEAD is not origin/main",
    `CI was not checked: ${commit} is not on GitHub's main`,
  ]);
  assert.match(
    describePlan(plan),
    /blocked:\n {2}- the worktree has uncommitted changes/,
  );
});

function cutWith(plan, execute, failing) {
  const ran = [];
  const logged = [];
  const step = (command, args) => {
    ran.push([command, ...args].join(" "));
    if (command === "git" && args[0] === failing)
      throw new Error(`${failing} failed`);
  };
  const run = () =>
    cut({ plan, execute, step, log: (line) => logged.push(line) });
  return { ran, logged, run };
}

const readyPlan = () =>
  webReleasePlan({ git: cleanMain, checkRuns: green, bump: "patch" });
const blockedPlan = () =>
  webReleasePlan({ git: cleanMain, checkRuns: [], bump: "patch" });

test("without --execute nothing runs, even when the release is ready", () => {
  const { ran, logged, run } = cutWith(readyPlan(), false);
  assert.equal(run(), 0);
  assert.deepEqual(ran, []);
  assert.match(logged.at(-1), /dry run: web-v0\.1\.0 was not created/);
});

test("a blocked release runs nothing and fails, even with --execute", () => {
  const { ran, run } = cutWith(blockedPlan(), true);
  assert.equal(run(), 1);
  assert.deepEqual(ran, []);
});

test("--execute on a ready release tags, then pushes", () => {
  const { ran, run } = cutWith(readyPlan(), true);
  assert.equal(run(), 0);
  assert.deepEqual(ran, [
    `git tag -a web-v0.1.0 ${commit} -m weblounge web 0.1.0`,
    "git push origin web-v0.1.0",
  ]);
});

test("a failed push says how to finish or undo the local tag", () => {
  const { logged, run } = cutWith(readyPlan(), true, "push");
  assert.throws(run, /push failed/);
  assert.match(
    logged.at(-1),
    /git push origin web-v0\.1\.0` or delete it with `git tag -d web-v0\.1\.0`/,
  );
});
