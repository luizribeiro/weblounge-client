import { expect, it, vi } from "vitest";
import { buildDebugIrcConfig, consumeDebugPassword } from "./debug-irc-config";

it("rejects a production build that receives a SASL password", () => {
  expect(() =>
    buildDebugIrcConfig("production", {
      WEBLOUNGE_IRC_ENDPOINT: "ws://127.0.0.1:8067",
      WEBLOUNGE_IRC_PASSWORD: "must-not-ship",
    }),
  ).toThrow("WEBLOUNGE_IRC_PASSWORD must not be set for production builds");
});

it("keeps the runtime password out of build-time debug config", () => {
  expect(
    buildDebugIrcConfig("development", {
      WEBLOUNGE_IRC_ENDPOINT: "ws://127.0.0.1:8067",
      WEBLOUNGE_IRC_PASSWORD: "runtime-only",
    }),
  ).not.toHaveProperty("password");
});

it("consumes and removes the runtime password from the URL", () => {
  const replace = vi.fn();
  const url = new URL(
    "http://127.0.0.1:5173/?irc-password=runtime-secret&keep=yes#channel",
  );

  expect(consumeDebugPassword(url, replace)).toBe("runtime-secret");
  expect(replace).toHaveBeenCalledWith("/?keep=yes#channel");
});
