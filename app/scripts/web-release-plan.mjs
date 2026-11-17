import { blockers } from "../../apps/tauri/release/plan.mjs";
import {
  BUMPS,
  nextReleaseVersion,
  releaseTag,
} from "../../apps/tauri/release/release-version.mjs";

export const REPOSITORY = "luizribeiro/weblounge-client";
export const CI_CHECK = "CI";

export function parseArguments(argv) {
  const options = { bump: "minor", execute: false };
  for (const argument of argv) {
    const flag = argument.startsWith("--") ? argument.slice(2) : undefined;
    if (flag === "execute") options.execute = true;
    else if (BUMPS.includes(flag)) options.bump = flag;
    else
      throw new Error(
        `unknown argument ${argument}; expected --patch, --minor, --major or --execute`,
      );
  }
  return options;
}

export function ciBlocker(checkRuns, commit) {
  if (checkRuns === undefined)
    return `CI was not checked: ${commit} is not on GitHub's main`;
  if (checkRuns instanceof Error)
    return `could not read CI for ${commit}: ${checkRuns.message}`;
  const runs = checkRuns.filter((run) => run.name === CI_CHECK);
  if (runs.length === 0) return `${CI_CHECK} has not run on ${commit}`;
  if (runs.some((run) => run.status !== "completed"))
    return `${CI_CHECK} is still running on ${commit}`;
  const failed = runs.find((run) => run.conclusion !== "success");
  return failed === undefined
    ? false
    : `${CI_CHECK} ended ${failed.conclusion} on ${commit}`;
}

export function webReleasePlan({ git, checkRuns, bump }) {
  const version = nextReleaseVersion(git.tags, bump);
  const tag = releaseTag(version);
  const commit = git.head;
  return {
    version,
    tag,
    commit,
    blockers: [
      ...blockers({ ...git, tag }),
      ciBlocker(checkRuns, commit),
    ].filter(Boolean),
    commands: [
      ["git", "tag", "-a", tag, commit, "-m", `weblounge ${version}`],
      ["git", "push", "origin", tag],
    ],
    pin: { commit, version },
  };
}

const shellWord = (word) =>
  /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

export const shellCommand = (command) => command.map(shellWord).join(" ");

export function describePlan(plan) {
  return [
    `release ${plan.tag} at ${plan.commit}`,
    "",
    "commands:",
    ...plan.commands.map((command) => `  ${shellCommand(command)}`),
    "",
    "server pin for irc.weblounge.org (weblounge-client):",
    `  rev = ${plan.pin.commit}`,
    `  version = ${plan.pin.version}`,
    ...(plan.blockers.length === 0
      ? []
      : ["", "blocked:", ...plan.blockers.map((blocker) => `  - ${blocker}`)]),
  ].join("\n");
}

export function cut({ plan, execute, step, log }) {
  log(describePlan(plan));
  if (plan.blockers.length > 0) return 1;
  if (!execute) {
    log(
      `\ndry run: ${plan.tag} was not created; pass --execute to create and push it`,
    );
    return 0;
  }
  for (const [command, ...args] of plan.commands) {
    try {
      step(command, args);
    } catch (error) {
      log(
        `\n${shellCommand([command, ...args])} failed; if ${plan.tag} exists locally, ` +
          `push it with \`git push origin ${plan.tag}\` or delete it with \`git tag -d ${plan.tag}\``,
      );
      throw error;
    }
  }
  return 0;
}
