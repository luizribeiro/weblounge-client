import { expect, it, vi } from "vitest";
import {
  buildDebugIrcConfig,
  consumeDebugConnection,
  debugAutojoin,
} from "./debug-irc-config";

it.each([
  "WEBLOUNGE_IRC_ENDPOINT",
  "WEBLOUNGE_IRC_NICKNAME",
  "WEBLOUNGE_IRC_ACCOUNT",
  "WEBLOUNGE_IRC_CHANNEL",
  "WEBLOUNGE_IRC_PASSWORD",
])("rejects %s in a production build", (name) => {
  expect(() =>
    buildDebugIrcConfig("production", {
      [name]: "must-not-ship",
    }),
  ).toThrow("WEBLOUNGE_IRC_* is unavailable in production builds");
});

it("allows the explicit production-shaped browser test harness", () => {
  expect(
    buildDebugIrcConfig(
      "production",
      { WEBLOUNGE_IRC_ENDPOINT: "ws://127.0.0.1:8067" },
      true,
    ),
  ).toMatchObject({ endpoint: "ws://127.0.0.1:8067" });
});

it("keeps the runtime password out of build-time debug config", () => {
  expect(
    buildDebugIrcConfig("development", {
      WEBLOUNGE_IRC_ENDPOINT: "ws://127.0.0.1:8067",
      WEBLOUNGE_IRC_PASSWORD: "runtime-only",
    }),
  ).not.toHaveProperty("password");
});

it("consumes runtime connection fields and removes them from the URL", () => {
  const replace = vi.fn();
  const url = new URL(
    "http://127.0.0.1:5173/?irc-password=runtime-secret&irc-account=tester&irc-nickname=tester-away&irc-channel=%23mine&irc-autojoin=%23two&irc-autojoin=&keep=yes#channel",
  );

  expect(consumeDebugConnection(url, replace)).toEqual({
    password: "runtime-secret",
    additionalAutojoin: ["#two"],
    account: "tester",
    nickname: "tester-away",
    channel: "#mine",
  });
  expect(replace).toHaveBeenCalledWith("/?keep=yes#channel");
});

it.each([
  {
    name: "joins the build-time channel first",
    connection: { password: "p", additionalAutojoin: ["#two", "#home"] },
    expected: ["#home", "#two"],
  },
  {
    name: "replaces the build-time channel with the runtime one",
    connection: {
      password: "p",
      additionalAutojoin: ["#mine", "#two"],
      channel: "#mine",
    },
    expected: ["#mine", "#two"],
  },
])("$name", ({ connection, expected }) => {
  expect(debugAutojoin(connection, "#home")).toEqual(expected);
});
