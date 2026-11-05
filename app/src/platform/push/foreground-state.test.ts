import { expect, it } from "vitest";
import { pageIsForeground } from "./foreground-state";

it("requires focus in an ordinary visible browser tab", () => {
  expect(pageIsForeground({ hidden: false, hasFocus: () => false }, {})).toBe(
    false,
  );
  expect(pageIsForeground({ hidden: false, hasFocus: () => true }, {})).toBe(
    true,
  );
});

it("trusts visibility in an installed iOS app with a false focus signal", () => {
  expect(
    pageIsForeground(
      { hidden: false, hasFocus: () => false },
      { standalone: true },
    ),
  ).toBe(true);
  expect(
    pageIsForeground(
      { hidden: true, hasFocus: () => true },
      { standalone: true },
    ),
  ).toBe(false);
});
