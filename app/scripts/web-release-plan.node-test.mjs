import assert from "node:assert/strict";
import test from "node:test";
import {
  ciBlocker,
  cut,
  describePlan,
  parseArguments,
  shellCommand,
  webReleasePlan,
} from "./web-release-plan.mjs";

const commit = "66f1c2ca0d9a4b7e8f1a2b3c4d5e6f708192a3b4";
const releasedTags = ["web-v0.1.0", "desktop-v0.1.3", "v0.2.0"];
const green = [{ name: "CI", status: "completed", conclusion: "success" }];
const cleanMain = {
  status: "",
  head: commit,
  originMain: commit,
  tags: releasedTags,
};

test("arguments default to a minor dry run", () => {
  assert.deepEqual(parseArguments([]), { bump: "minor", execute: false });
  assert.deepEqual(parseArguments(["--patch", "--execute"]), {
    bump: "patch",
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

test("a clean, green main plans the next minor tag, its commands and the server pin", () => {
  const plan = webReleasePlan({
    git: cleanMain,
    checkRuns: green,
    bump: "minor",
  });
  assert.equal(plan.tag, "v0.3.0");
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.commands.map(shellCommand), [
    `git tag -a v0.3.0 ${commit} -m 'weblounge 0.3.0'`,
    "git push origin v0.3.0",
  ]);
  assert.deepEqual(plan.pin, { commit, version: "0.3.0" });
  const described = describePlan(plan);
  assert.match(described, /git push origin v0\.3\.0/);
  assert.match(
    described,
    new RegExp(`rev = ${commit}\n {2}version = 0\\.3\\.0`),
  );
  assert.doesNotMatch(described, /blocked:/);
});

test("every unmet precondition is listed at once", () => {
  const plan = webReleasePlan({
    git: {
      status: " M app/src/App.tsx",
      head: commit,
      originMain: "0".repeat(40),
      tags: [...releasedTags, "v0.2.1"],
    },
    checkRuns: undefined,
    bump: "patch",
  });
  assert.equal(plan.tag, "v0.2.2");
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
  webReleasePlan({ git: cleanMain, checkRuns: green, bump: "minor" });
const blockedPlan = () =>
  webReleasePlan({ git: cleanMain, checkRuns: [], bump: "minor" });

test("without --execute nothing runs, even when the release is ready", () => {
  const { ran, logged, run } = cutWith(readyPlan(), false);
  assert.equal(run(), 0);
  assert.deepEqual(ran, []);
  assert.match(logged.at(-1), /dry run: v0\.3\.0 was not created/);
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
    `git tag -a v0.3.0 ${commit} -m weblounge 0.3.0`,
    "git push origin v0.3.0",
  ]);
});

test("a failed push says how to finish or undo the local tag", () => {
  const { logged, run } = cutWith(readyPlan(), true, "push");
  assert.throws(run, /push failed/);
  assert.match(
    logged.at(-1),
    /git push origin v0\.3\.0` or delete it with `git tag -d v0\.3\.0`/,
  );
});
