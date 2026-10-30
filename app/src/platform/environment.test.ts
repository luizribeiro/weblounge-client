import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopPanelBoundary,
  installPlatformEnvironment,
  resolveEnvironment,
  resolveKeyboardGeometry,
  resolveShortcutPlatform,
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

  it("centralizes shortcut-label platform adaptation", () => {
    expect(resolveShortcutPlatform({ platform: "MacIntel" })).toBe("macos");
    expect(resolveShortcutPlatform({ platform: "Linux x86_64" })).toBe("other");
  });

  it("maps visual viewport geometry to keyboard state", () => {
    expect(resolveKeyboardGeometry(874, { height: 874, offsetTop: 0 })).toEqual(
      { inset: 0, state: "closed" },
    );
    expect(
      resolveKeyboardGeometry(874, { height: 516, offsetTop: 42 }),
    ).toEqual({ inset: 316, state: "open" });
    expect(resolveKeyboardGeometry(874, { height: 900, offsetTop: 0 })).toEqual(
      { inset: 0, state: "closed" },
    );
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
});
