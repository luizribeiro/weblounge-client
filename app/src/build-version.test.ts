import { expect, it } from "vitest";
import { formatBuildVersion } from "./build-version";

const fullCommit = "68ea9a3c1f0e5b2d9a7c4e8f3b6d1a0c9e2f4b7a";

it("formats production build identity in UTC to the minute", () => {
  const timestamp = Date.UTC(2026, 10, 1, 6, 40, 30) / 1_000;
  expect(formatBuildVersion(fullCommit, timestamp)).toEqual({
    version: "68ea9a3",
    commit: fullCommit,
    sha: "68ea9a3",
    builtAt: new Date("2026-11-01T06:40:30.000Z"),
    built: "2026-11-01 06:40 UTC",
    text: "weblounge 68ea9a3 · built 2026-11-01 06:40 UTC",
  });
});

it.each([
  "dirty",
  "ci",
  "68ea9a3",
  fullCommit.slice(0, 39),
  `${fullCommit}0`,
  fullCommit.toUpperCase(),
])("keeps %s whole when it is not a full commit", (commit) => {
  expect(formatBuildVersion(commit, 0)).toMatchObject({ commit, sha: commit });
});

it("labels the development server without a fake timestamp", () => {
  expect(formatBuildVersion("dev", 0)).toEqual({
    version: "dev",
    commit: "dev",
    sha: "dev",
    builtAt: null,
    built: null,
    text: "weblounge dev",
  });
});

it("rejects an unreadable build timestamp", () => {
  expect(() => formatBuildVersion(fullCommit, Number.NaN)).toThrow(
    "invalid build timestamp",
  );
});
