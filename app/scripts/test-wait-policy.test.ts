import { expect, it } from "vitest";
import { waitPolicyViolations } from "./test-wait-policy.ts";

it("flags fixed sleeps, retries, slowed tests and raised timeouts", () => {
  const source = [
    "await page.waitForTimeout(250);",
    "await new Promise((resolve) => setTimeout(resolve, 250));",
    "export default defineConfig({ retries: 2 });",
    "test.slow();",
    "await expect(row).toBeVisible({ timeout: 15_000 });",
  ].join("\n");

  expect(waitPolicyViolations(source).map((v) => [v.line, v.reason])).toEqual([
    [1, "fixed sleep"],
    [2, "fixed sleep"],
    [3, "test retries"],
    [4, "slowed test timeout"],
    [5, "raised timeout"],
  ]);
});

it("allows condition waits, short timeouts and justified observation windows", () => {
  const source = [
    "await expect(panel).toBeVisible();",
    "await expect.poll(() => distanceFromBottom(list), { timeout: 3_000 }).toBe(0);",
    "// wait-ok: measures idle work over a fixed window",
    "await page.waitForTimeout(idleObservationMilliseconds);",
    "await page.waitForTimeout(150); // wait-ok: holds the pointer to set fling velocity",
  ].join("\n");

  expect(waitPolicyViolations(source)).toEqual([]);
});

it("never exempts raised timeouts or slowed tests outside performance specs", () => {
  const source = [
    "test.slow(); // wait-ok: many messages",
    "await expect(row).toBeVisible({ timeout: 15_000 }); // wait-ok: slow replay",
  ].join("\n");

  expect(
    waitPolicyViolations(source, "e2e/engine.spec.ts").map((v) => v.reason),
  ).toEqual(["slowed test timeout", "raised timeout"]);
  expect(
    waitPolicyViolations(
      "test.slow();",
      "e2e/message-list-performance.spec.ts",
    ),
  ).toEqual([]);
});
