import { expect, it } from "vitest";
import { OneShotAccessToken } from "./HostedSession";

it("hands an access token over exactly once", () => {
  const token = new OneShotAccessToken("one-shot-secret", 1234);
  expect(token.expiresAt).toBe(1234);
  expect(token.take()).toBe("one-shot-secret");
  expect(() => token.take()).toThrow("already consumed");
  expect(JSON.stringify(token)).not.toContain("one-shot-secret");
});
