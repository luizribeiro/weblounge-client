import { describe, expect, it } from "vitest";
import type { CommandSpec } from "../../engine/protocol";
import {
  attachmentLabel,
  captionTakesImage,
  failureMessage,
  formatBytes,
  messageWithImage,
} from "./attachment";

const url = "https://files.weblounge.org/AbCdEfGhIjKlMnOpQrStUv.png";

function command(name: string, aliases: string[] = []): CommandSpec {
  return { name, aliases } as unknown as CommandSpec;
}
const commands = [command("me"), command("say"), command("join", ["j"])];

describe("messageWithImage", () => {
  it("puts the URL after the caption with one space", () => {
    expect(messageWithImage("look at this", url)).toBe(`look at this ${url}`);
    expect(messageWithImage("two lines\nhere\n", url)).toBe(
      `two lines\nhere ${url}`,
    );
    expect(messageWithImage("", url)).toBe(url);
    expect(messageWithImage("  \n", url)).toBe(url);
  });
});

describe("captionTakesImage", () => {
  it("accepts text, literals, actions and /say", () => {
    for (const caption of [
      "",
      "hello",
      "//join is a command",
      "/me waves",
      "/SAY hi",
    ])
      expect(captionTakesImage(caption, commands), caption).toBe(true);
  });

  it("refuses other and unknown commands", () => {
    for (const caption of ["/join #lounge", "/j #lounge", "/nonsense"])
      expect(captionTakesImage(caption, commands), caption).toBe(false);
  });
});

describe("labels and failures", () => {
  it("formats sizes compactly", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(48_200)).toBe("48 KB");
    expect(formatBytes(1_234_567)).toBe("1.2 MB");
    expect(attachmentLabel(10_000_000)).toBe("Image · 10.0 MB");
  });

  it("explains every failure", () => {
    expect(failureMessage({ kind: "too_large", limit: 10_000_000 })).toBe(
      "Image is too large (max 10.0 MB).",
    );
    expect(failureMessage({ kind: "too_large" })).toBe("Image is too large.");
    expect(
      failureMessage({ kind: "failed", status: 503, detail: "Scrubber down." }),
    ).toBe("Upload failed: Scrubber down.");
    expect(failureMessage({ kind: "failed", status: 400 })).toBe(
      "Upload failed.",
    );
    expect(failureMessage({ kind: "offline" })).toBe("You’re offline.");
    expect(failureMessage({ kind: "rate_limited" })).toBe(
      "Too many uploads. Try again later.",
    );
    expect(failureMessage({ kind: "command" })).toBe(
      "Send commands without an image.",
    );
  });
});
