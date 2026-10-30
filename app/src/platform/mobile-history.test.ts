import { expect, it } from "vitest";
import { mobileHistoryPolicy } from "./mobile-history";

it("replaces in-app history in touch WebKit browser tabs", () => {
  expect(
    mobileHistoryPolicy({
      displayModeStandalone: false,
      navigatorStandalone: false,
      coarsePointer: true,
      webkitPoint: true,
    }),
  ).toBe("replace");
});

it("keeps a platform back stack in installed apps and Android", () => {
  expect(
    mobileHistoryPolicy({
      displayModeStandalone: true,
      navigatorStandalone: false,
      coarsePointer: true,
      webkitPoint: true,
    }),
  ).toBe("stack");
  expect(
    mobileHistoryPolicy({
      displayModeStandalone: false,
      navigatorStandalone: false,
      coarsePointer: true,
      webkitPoint: false,
    }),
  ).toBe("stack");
});
