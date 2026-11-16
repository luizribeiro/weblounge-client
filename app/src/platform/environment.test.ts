import { afterEach, describe, expect, it, vi } from "vitest";
import { type ThemeDefinition, themes } from "../theme/theme-registry";
import {
  desktopPanelBoundary,
  installPlatformEnvironment,
  resolveEnvironment,
  resolveShortcutPlatform,
  resolveShortcutShell,
} from "./environment";

class FakeMediaQuery {
  readonly media: string;
  matches: boolean;
  onchange = null;
  private listener: (() => void) | undefined;

  constructor(media: string, matches: boolean) {
    this.media = media;
    this.matches = matches;
  }

  addEventListener(_type: "change", listener: () => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: "change", listener: () => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  change(matches: boolean): void {
    this.matches = matches;
    this.listener?.();
  }
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("platform environment", () => {
  it("maps web primary input and display capabilities", () => {
    expect(resolveEnvironment("web", false, false, "overlay")).toEqual({
      input: "mouse",
      display: "browser",
      shell: "desktop",
      desktopPanels: "overlay",
    });
    expect(resolveEnvironment("web", true, true, "inline")).toEqual({
      input: "touch",
      display: "standalone",
      shell: "mobile",
      desktopPanels: "inline",
    });
  });

  it("takes Tauri shell and input from the build target", () => {
    expect(resolveEnvironment("tauri-desktop", true, true, "inline")).toEqual({
      input: "mouse",
      display: "tauri",
      shell: "desktop",
      desktopPanels: "inline",
    });
    expect(resolveEnvironment("tauri-mobile", false, false, "overlay")).toEqual(
      {
        input: "touch",
        display: "tauri",
        shell: "mobile",
        desktopPanels: "overlay",
      },
    );
  });

  it("uses the native keymap in Tauri and the Mac app, and the web keymap elsewhere", () => {
    expect(resolveShortcutShell("web", "web")).toBe("web");
    expect(resolveShortcutShell("web", "macos-app")).toBe("native");
    expect(resolveShortcutShell("tauri-desktop", "web")).toBe("native");
  });

  it("centralizes shortcut-label platform adaptation", () => {
    expect(resolveShortcutPlatform({ platform: "MacIntel" })).toBe("macos");
    expect(resolveShortcutPlatform({ platform: "Linux x86_64" })).toBe("linux");
    expect(resolveShortcutPlatform({ platform: "Win32" })).toBe("other");
  });

  it("publishes capability changes without treating width as shell selection", () => {
    const queries = new Map<string, FakeMediaQuery>();
    const matchMedia = vi.fn((query: string) => {
      const media = new FakeMediaQuery(query, false);
      queries.set(query, media);
      return media as unknown as MediaQueryList;
    });
    vi.stubGlobal("matchMedia", matchMedia);
    const root = document.createElement("div");
    document.body.append(root);
    let widthChanged: ((width: number) => void) | undefined;
    const controller = installPlatformEnvironment(root, window, {
      observeWidth: (_element, onWidth) => {
        widthChanged = onWidth;
        return () => {};
      },
    });

    expect(root.dataset.shell).toBe("desktop");
    expect(root.dataset.desktopPanels).toBe("inline");
    widthChanged?.(desktopPanelBoundary - 1);
    expect(root.dataset.shell).toBe("desktop");
    expect(root.dataset.desktopPanels).toBe("overlay");

    queries.get("(hover: none) and (pointer: coarse)")?.change(true);
    expect(controller.environment().shell).toBe("mobile");
    expect(root.dataset.input).toBe("touch");
    controller.dispose();
  });

  it("has no window controls in a plain browser", () => {
    const root = document.createElement("div");
    const browser = installPlatformEnvironment(root, window);

    expect(browser.windowControls()).toBeUndefined();
    expect(root.dataset.windowControls).toBeUndefined();
    expect(() =>
      browser.applyWindowTheme(themes[0] as ThemeDefinition),
    ).not.toThrow();
    browser.dispose();
  });

  it("exposes the wrapper's window controls and themes its window", () => {
    const commands: string[] = [];
    vi.stubGlobal("__WEBLOUNGE_SHELL__", {
      kind: "macos-app",
      version: "0.2.0",
      windowControls: { inlineStart: 84, blockSize: 48 },
    });
    vi.stubGlobal("__TAURI_INTERNALS__", {
      invoke: (command: string) => {
        commands.push(command);
        return new Promise(() => {});
      },
    });
    const root = document.createElement("div");
    const app = installPlatformEnvironment(root, window);

    expect(app.windowControls()).toBe("overlay");
    expect(root.dataset.windowControls).toBe("pending");
    app.applyWindowTheme(themes[0] as ThemeDefinition);
    expect(commands).toContain("plugin:window|set_theme");
    app.dispose();
    expect(root.dataset.windowControls).toBeUndefined();
  });
});
