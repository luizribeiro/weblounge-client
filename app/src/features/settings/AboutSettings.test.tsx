import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseChannelProvider } from "../../hosted/release-channel";
import { installPlatformEnvironment } from "../../platform/environment";
import { AboutSettings } from "./AboutSettings";

function stubClipboard(writeText: (text: string) => Promise<void>) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (X11; Linux x86_64)",
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

function fact(name: string): string | null | undefined {
  return screen.getByText(name, { selector: "dt" }).nextElementSibling
    ?.textContent;
}

describe("AboutSettings", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    installPlatformEnvironment(document.body, window, { target: "web" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names the beta channel under the brand mark", () => {
    render(() => (
      <ReleaseChannelProvider value={() => "beta"}>
        <AboutSettings />
      </ReleaseChannelProvider>
    ));
    expect(screen.getByRole("heading", { name: "weblounge β" })).toBeVisible();
    expect(fact("Channel")).toBe("Beta");
    expect(fact("Version")).toBe("dev");
    expect(fact("Platform")).toBe("Browser tab");
  });

  it("is a release build where nothing names a channel", () => {
    render(() => <AboutSettings />);
    expect(screen.getByRole("heading", { name: "weblounge" })).toBeVisible();
    expect(fact("Channel")).toBe("Release");
  });

  it("copies the debug info and says so", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    render(() => <AboutSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Copy debug info" }));
    await expect(screen.findByText("Copied")).resolves.toBeVisible();
    expect(writeText).toHaveBeenCalledWith(
      [
        "weblounge debug info",
        "Version: dev",
        "Commit: dev",
        "Built: Development server",
        "Channel: Release",
        "Platform: Browser tab",
        "User agent: Mozilla/5.0 (X11; Linux x86_64)",
      ].join("\n"),
    );
  });

  it("says when the clipboard refuses the copy", async () => {
    stubClipboard(() => Promise.reject(new Error("NotAllowedError")));
    render(() => <AboutSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Copy debug info" }));
    await expect(screen.findByText("Couldn't copy")).resolves.toBeVisible();
  });

  it("clears a refused copy once a retry succeeds", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("NotAllowedError"))
      .mockResolvedValueOnce(undefined);
    stubClipboard(writeText);
    render(() => <AboutSettings />);
    const copy = screen.getByRole("button", { name: "Copy debug info" });
    fireEvent.click(copy);
    await expect(screen.findByText("Couldn't copy")).resolves.toBeVisible();
    fireEvent.click(copy);
    await expect(screen.findByText("Copied")).resolves.toBeVisible();
    expect(screen.queryByText("Couldn't copy")).toBeNull();
  });
});
