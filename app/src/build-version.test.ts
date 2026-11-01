import { expect, it } from "vitest";
import { formatBuildVersion } from "./build-version";

it("formats production build identity in UTC to the minute", () => {
  const timestamp = Date.UTC(2026, 10, 1, 6, 40, 30) / 1_000;
  expect(formatBuildVersion("68ea9a3", timestamp)).toEqual({
    sha: "68ea9a3",
    builtAt: new Date("2026-11-01T06:40:30.000Z"),
    text: "weblounge 68ea9a3 · built 2026-11-01 06:40 UTC",
  });
});

it("labels the development server without a fake timestamp", () => {
  expect(formatBuildVersion("dev", 0)).toEqual({
    sha: "dev",
    builtAt: null,
    text: "weblounge dev",
  });
});
