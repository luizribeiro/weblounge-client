import { blockers } from "../../apps/tauri/release/plan.mjs";

export const WEB_TAG_PREFIX = "web-v";
export const FIRST_WEB_VERSION = "0.1.0";
export const REPOSITORY = "luizribeiro/weblounge-client";
export const CI_CHECK = "CI";
const BUMPS = ["patch", "minor", "major"];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function parseArguments(argv) {
  const options = { bump: "patch", execute: false };
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

const webVersions = (tags) =>
  tags
    .filter((tag) => tag.startsWith(WEB_TAG_PREFIX))
    .map((tag) => SEMVER.exec(tag.slice(WEB_TAG_PREFIX.length)))
    .filter(Boolean)
    .map((match) => match.slice(1).map(Number));

const byVersion = (left, right) =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

export function nextWebVersion(tags, bump) {
  const latest = webVersions(tags).sort(byVersion).at(-1);
  if (latest === undefined) return FIRST_WEB_VERSION;
  const [major, minor, patch] = latest;
  switch (bump) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      throw new Error(`unknown bump ${bump}`);
  }
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
  const version = nextWebVersion(git.tags, bump);
  const tag = `${WEB_TAG_PREFIX}${version}`;
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
      ["git", "tag", "-a", tag, commit, "-m", `weblounge web ${version}`],
      ["git", "push", "origin", tag],
    ],
    pin: {
      tag,
      commit,
      flake: `github:${REPOSITORY}/${commit}`,
      flakeByTag: `github:${REPOSITORY}/${tag}`,
    },
  };
}

const shellWord = (word) =>
  /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

export const shellCommand = (command) => command.map(shellWord).join(" ");

export function describePlan(plan) {
  return [
    `web release ${plan.tag} at ${plan.commit}`,
    "",
    "commands:",
    ...plan.commands.map((command) => `  ${shellCommand(command)}`),
    "",
    "server pin for irc.weblounge.org (weblounge-client flake input):",
    `  ${plan.pin.flake}`,
    `  (or by tag: ${plan.pin.flakeByTag})`,
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
