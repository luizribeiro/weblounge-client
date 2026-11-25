import { expect, it } from "vitest";
import { appearanceHintKey } from "../theme/appearance-hint";
import { deploymentConfigCacheKey } from "./deployment-config";
import {
  clientMinBuildReloadKey,
  clientResetTokenKey,
} from "./emergency-switch";
import { forgetMemberStorage } from "./member-storage";
import { signedOutKey } from "./signed-out";

it("forgets every member key, including ones no list names", () => {
  localStorage.setItem("weblounge.navigation.last-viewed", "/weblounge/%23ops");
  localStorage.setItem(
    "weblounge.inline-image-sizes",
    '{"https://files.weblounge.org/a.png":[640,480]}',
  );
  localStorage.setItem("weblounge:draft:channel%3A%23lounge", "half a thought");
  localStorage.setItem("weblounge.desktop.member-visibility", "{}");
  localStorage.setItem("another-app", "untouched");

  forgetMemberStorage(localStorage);

  expect(Object.keys(localStorage)).toEqual(["another-app"]);
});

it("keeps what describes the device and deployment", () => {
  const deviceKeys = [
    appearanceHintKey,
    deploymentConfigCacheKey,
    clientMinBuildReloadKey,
    clientResetTokenKey,
    signedOutKey,
    "weblounge.debug.viewport",
  ];
  for (const key of deviceKeys) sessionStorage.setItem(key, "kept");

  forgetMemberStorage(sessionStorage);

  expect(Object.keys(sessionStorage).sort()).toEqual([...deviceKeys].sort());
});

it("leaves storage it can't reach alone", () => {
  const blocked = {
    get length(): number {
      throw new DOMException("blocked", "SecurityError");
    },
    key: () => null,
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  } satisfies Storage;

  expect(() => forgetMemberStorage(blocked)).not.toThrow();
});
