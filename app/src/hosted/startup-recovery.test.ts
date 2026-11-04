import { expect, it } from "vitest";
import {
  failedStartupRetryCount,
  shouldOfferAppReset,
} from "./startup-recovery";

it("offers an app reset only after two consecutive failed retries", () => {
  let failures = failedStartupRetryCount(0, false);
  expect(shouldOfferAppReset(failures)).toBe(false);

  failures = failedStartupRetryCount(failures, true);
  expect(shouldOfferAppReset(failures)).toBe(false);

  failures = failedStartupRetryCount(failures, true);
  expect(shouldOfferAppReset(failures)).toBe(true);
});

it("starts the count over for a failure that did not follow Retry", () => {
  expect(failedStartupRetryCount(1, false)).toBe(0);
});
