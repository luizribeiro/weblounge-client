import { describe, expect, it } from "vitest";
import { type MessageKey, messages, t } from "./strings";

const messageKeys = Object.keys(messages).filter(
  (key): key is MessageKey =>
    key.startsWith("engine.") ||
    [
      "composer.empty_input",
      "composer.missing_argument",
      "composer.unexpected_argument",
      "composer.unknown_command",
    ].includes(key),
);

describe("composer strings", () => {
  it.each(messageKeys)("renders %s as a complete sentence", (key) => {
    const message = t(key, { input: "/whois #garden", target: "#garden" });

    expect(message).toMatch(/^[A-Z]/u);
    expect(message).toMatch(/[.!?]$/u);
  });

  it("includes the rejected command parameter", () => {
    expect(t("composer.unknown_command", { input: "/whois mel" })).toBe(
      "Unknown command /whois.",
    );
  });

  it("includes the rejected join target parameter", () => {
    expect(t("engine.join_banned", { input: "/join #garden secret" })).toBe(
      "Couldn't join #garden: you're banned.",
    );
    expect(t("engine.join_refused", { input: "/join #garden secret" })).toBe(
      "Couldn't join #garden: that channel isn't available.",
    );
  });

  it("explains the channel state limit without exposing a raw engine error", () => {
    expect(t("engine.channel_limit_reached")).toBe(
      "You're in the maximum number of channels for this server.",
    );
  });

  it("names the channel for membership refusals", () => {
    expect(t("engine.not_in_channel", { target: "#garden" })).toBe(
      "You're not in #garden.",
    );
  });

  it("explains when a guarded direct recipient is gone", () => {
    expect(t("engine.direct_target_gone")).toContain("nickname now belongs");
  });

  it("explains degraded direct presence", () => {
    expect(t("engine.direct_presence_unavailable")).toContain(
      "Presence updates are unavailable",
    );
  });

  it("explains why an unverified direct message is disabled", () => {
    expect(t("engine.direct_monitor_full")).toContain(
      "Close one to message them",
    );
  });

  it("explains when a channel identity changed while disconnected", () => {
    expect(t("engine.channel_recreated")).toContain("channel was recreated");
  });

  it("gives connection failures actionable checks", () => {
    expect(t("engine.connection_failed")).toContain("certificate");
    expect(t("engine.connection_failed")).toContain("site is allowed");
  });

  it.each([
    "close",
    "cycle",
    "help",
    "identify",
    "join",
    "me",
    "msg",
    "nick",
    "notice",
    "part",
    "query",
    "quit",
    "say",
    "topic",
  ] as const)("renders human usage and description for %s", (command) => {
    expect(t(`cmd.${command}.usage`)).toMatch(/^\//u);
    expect(t(`cmd.${command}.description`)).not.toContain("cmd.");
  });
});
