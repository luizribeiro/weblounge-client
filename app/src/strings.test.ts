import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ENGINE_MESSAGE_KEYS } from "./engine/generated/EngineMessageKeys";
import { isMessageKey, messages, t, translate } from "./strings";

const appSource = resolve(process.cwd(), "src");

describe("app strings", () => {
  it("interpolates named values", () => {
    expect(t("engine.not_in_channel", { target: "#garden" })).toBe(
      "You're not in #garden.",
    );
  });

  it("makes a missing runtime key visible", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(translate("engine.future_error")).toBe("engine.future_error");
    expect(error).toHaveBeenCalledWith(
      "Missing message key: engine.future_error",
    );

    error.mockRestore();
  });

  it("gives every previously missing key specific copy", () => {
    expect(t("composer.unexpected_argument")).toBe(
      "That command has an unexpected argument.",
    );
    expect(t("engine.channel_not_found")).toBe("That channel isn't available.");
    expect(t("engine.read_marker_invalid")).toBe(
      "That read position isn't available on this server.",
    );
    expect(t("engine.mark_read_failed")).toBe(
      "Couldn't mark this conversation as read.",
    );
  });

  it("contains every literal key passed to t in the app", () => {
    const usedKeys = sourceFiles(appSource, [".ts", ".tsx"]).flatMap((file) =>
      [
        ...readFileSync(file, "utf8").matchAll(/\bt\(\s*["']([^"']+)["']/gu),
      ].map((match) => match[1] ?? ""),
    );

    expect(usedKeys.filter((key) => !isMessageKey(key))).toEqual([]);
  });

  it("contains every message key emitted by the Rust engine", () => {
    expect(ENGINE_MESSAGE_KEYS.filter((key) => !isMessageKey(key))).toEqual([]);
  });

  it("has no empty messages", () => {
    const allMessages: readonly string[] = Object.values(messages);
    expect(allMessages.filter((message) => message === "")).toEqual([]);
  });
});

function sourceFiles(root: string, extensions: readonly string[]): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, extensions);
    return extensions.includes(extname(entry.name)) ? [path] : [];
  });
}
