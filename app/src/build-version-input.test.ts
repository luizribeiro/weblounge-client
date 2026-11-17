import { expect, test } from "vitest";
import { buildVersionFromEnv } from "./build-version-input";

test("a production build carries the release version it was given", () => {
  expect(
    buildVersionFromEnv("production", { WEBLOUNGE_VERSION: "0.2.0" }),
  ).toBe("0.2.0");
  expect(
    buildVersionFromEnv("production", { WEBLOUNGE_VERSION: "0.2.0+14" }),
  ).toBe("0.2.0+14");
});

test("builds that were given no version carry none", () => {
  expect(buildVersionFromEnv("production", {})).toBeNull();
  expect(
    buildVersionFromEnv("production", { WEBLOUNGE_VERSION: "" }),
  ).toBeNull();
});

test("development and test builds carry no version even when one is set", () => {
  for (const mode of ["development", "test"]) {
    expect(
      buildVersionFromEnv(mode, { WEBLOUNGE_VERSION: "0.2.0+14" }),
    ).toBeNull();
  }
});

test("a version that is not describe-style is a build error", () => {
  for (const version of [
    "v0.2.0",
    "0.2",
    "0.2.0-rc.1",
    "0.2.0+0",
    "01.2.0",
    "dirty",
  ]) {
    expect(() =>
      buildVersionFromEnv("production", { WEBLOUNGE_VERSION: version }),
    ).toThrow(`WEBLOUNGE_VERSION ${version} is not X.Y.Z or X.Y.Z+N`);
  }
});
