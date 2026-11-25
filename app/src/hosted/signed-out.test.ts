import { expect, it } from "vitest";
import { clearSignedOut, isSignedOut, markSignedOut } from "./signed-out";

it("remembers a sign-out until the member signs in again", () => {
  const storage = new Map<string, string>();
  const device = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };

  expect(isSignedOut(device)).toBe(false);
  markSignedOut(device);
  expect(isSignedOut(device)).toBe(true);
  clearSignedOut(device);
  expect(isSignedOut(device)).toBe(false);
});

it("treats storage it can't reach as signed in", () => {
  const blocked = {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("full", "QuotaExceededError");
    },
    removeItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
  };

  expect(() => markSignedOut(blocked)).not.toThrow();
  expect(() => clearSignedOut(blocked)).not.toThrow();
  expect(isSignedOut(blocked)).toBe(false);
});
