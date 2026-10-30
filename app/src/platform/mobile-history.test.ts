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

it("replaces in-app history in touch WebKit standalone mode", () => {
  expect(
    mobileHistoryPolicy({
      displayModeStandalone: true,
      navigatorStandalone: false,
      coarsePointer: true,
      webkitPoint: true,
    }),
  ).toBe("replace");
  expect(
    mobileHistoryPolicy({
      displayModeStandalone: false,
      navigatorStandalone: true,
      coarsePointer: true,
      webkitPoint: true,
    }),
  ).toBe("replace");
});

it("keeps a platform back stack on Android", () => {
  expect(
    mobileHistoryPolicy({
      displayModeStandalone: false,
      navigatorStandalone: false,
      coarsePointer: true,
      webkitPoint: false,
    }),
  ).toBe("stack");
});
