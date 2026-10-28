import { describe, expect, it } from "vitest";
import { messageKeys, t } from "./strings";

describe("composer strings", () => {
  it.each(messageKeys)("renders %s as a complete sentence", (key) => {
    const message = t(key, { input: "/whois #garden" });

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
  });
});
