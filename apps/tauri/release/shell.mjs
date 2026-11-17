import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeCommit } from "./release-version.mjs";

export const repo = new URL("../../../", import.meta.url).pathname;
export const crate = join(repo, "apps/tauri");

export const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: repo, encoding: "utf8", ...options }).trim();

export const step = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: repo, stdio: "inherit", ...options });

export const crateFile = (name) => readFileSync(join(crate, name), "utf8");

export const fetchMainAndTags = () =>
  run("git", ["fetch", "--quiet", "--tags", "origin", "main"]);

export function gitState() {
  fetchMainAndTags();
  return {
    status: run("git", ["status", "--porcelain"]),
    head: run("git", ["rev-parse", "HEAD"]),
    originMain: run("git", ["rev-parse", "origin/main"]),
    tags: run("git", ["tag", "--list"]).split("\n"),
  };
}

export const commitVersionOf = (commit) => describeCommit(commit, (args) => run("git", args));
