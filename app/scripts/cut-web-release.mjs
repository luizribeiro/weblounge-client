import { gitState, run, step } from "../../apps/tauri/release/shell.mjs";
import {
  CI_CHECK,
  cut,
  parseArguments,
  REPOSITORY,
  webReleasePlan,
} from "./web-release-plan.mjs";

function checkRuns(commit) {
  try {
    return JSON.parse(
      run(
        "gh",
        [
          "api",
          `repos/${REPOSITORY}/commits/${commit}/check-runs?check_name=${CI_CHECK}&filter=latest`,
          "--jq",
          ".check_runs",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  } catch (error) {
    return new Error(error.stderr?.trim() || error.message);
  }
}

const options = parseArguments(process.argv.slice(2));
const git = gitState();
const plan = webReleasePlan({
  git,
  checkRuns: git.head === git.originMain ? checkRuns(git.head) : undefined,
  bump: options.bump,
});
process.exitCode = cut({
  plan,
  execute: options.execute,
  step,
  log: console.log,
});
