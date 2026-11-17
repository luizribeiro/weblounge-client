import { describe, expect, it } from "vitest";
import { formatBuildVersion } from "../../build-version";
import { type AboutInput, aboutFacts, debugInfoText } from "./about-facts";

const fullCommit = "68ea9a3c1f0e5b2d9a7c4e8f3b6d1a0c9e2f4b7a";
const builtAt = Date.UTC(2026, 10, 16, 6, 40) / 1_000;
const safariOnMac =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

const macBeta: AboutInput = {
  build: formatBuildVersion(fullCommit, builtAt, "0.2.0+14"),
  channel: "beta",
  shell: { kind: "macos-app", version: "0.2.0+3" },
  display: "tauri",
};

function shown(input: AboutInput): Record<string, string> {
  return Object.fromEntries(
    aboutFacts(input).map(({ label, value }) => [label, value]),
  );
}

describe("about facts", () => {
  it("shows the release version beside the short commit and the shell version", () => {
    expect(shown(macBeta)).toEqual({
      "settings.about.version": "0.2.0+14",
      "settings.about.commit": "68ea9a3",
      "settings.about.built": "2026-11-16 06:40 UTC",
      "settings.about.channel": "Beta",
      "settings.about.platform": "Mac app 0.2.0+3",
    });
  });

  it.each([
    ["iOS app 0.1.2", { kind: "ios-app", version: "0.1.2" } as const, "tauri"],
    ["Installed web app", undefined, "standalone"],
    ["Browser tab", undefined, "browser"],
    ["Native app", undefined, "tauri"],
  ] as const)("names the platform %s", (name, shell, display) => {
    expect(
      shown({ ...macBeta, shell, display })["settings.about.platform"],
    ).toBe(name);
  });

  it("labels the development server's build", () => {
    const facts = shown({
      ...macBeta,
      build: formatBuildVersion("dev", 0),
      channel: "release",
    });
    expect(facts["settings.about.version"]).toBe("dev");
    expect(facts["settings.about.built"]).toBe("Development server");
    expect(facts["settings.about.channel"]).toBe("Release");
  });
});

describe("debug info text", () => {
  const text = debugInfoText(aboutFacts(macBeta), safariOnMac);

  it("copies the shown facts with the full commit and the user agent", () => {
    expect(text).toBe(
      [
        "weblounge debug info",
        "Version: 0.2.0+14",
        `Commit: ${fullCommit}`,
        "Built: 2026-11-16 06:40 UTC",
        "Channel: Beta",
        "Platform: Mac app 0.2.0+3",
        `User agent: ${safariOnMac}`,
      ].join("\n"),
    );
  });

  it("carries no token- or key-shaped value besides the commit", () => {
    const withoutCommit = text.replace(fullCommit, "");
    expect(withoutCommit).not.toMatch(/[A-Za-z0-9_-]{20,}/u);
  });

  it("copies the development server's build without a date", () => {
    const dev = { ...macBeta, build: formatBuildVersion("dev", 0) };
    expect(debugInfoText(aboutFacts(dev), safariOnMac)).toContain(
      "Version: dev\nCommit: dev\nBuilt: Development server\n",
    );
  });
});
