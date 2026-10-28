import { describe, expect, it, vi } from "vitest";
import { installTheme } from "./theme-controller";
import {
  motionTokens,
  nickPaletteSize,
  themeStyleSheet,
  themes,
} from "./theme-registry";

class FakeMedia {
  listener: (() => void) | undefined;

  constructor(public matches: boolean) {}

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

describe("theme registry", () => {
  it("loads Lounge themes and emits their tokens", () => {
    expect(themes.map((theme) => theme.id)).toEqual(["lounge", "lounge-night"]);
    expect(themes[0]?.nickPalette).toHaveLength(6);
    expect(nickPaletteSize).toBe(6);
    expect(themeStyleSheet()).toContain("--wl-color-bg:#f3f1e9");
    expect(themeStyleSheet()).toContain("--wl-color-bg:#18221e");
    expect(themes[1]?.onboarding).not.toHaveProperty("soft");
    expect(themes[1]?.onboarding).not.toHaveProperty("signal");
  });

  it("owns motion tokens and their reduced-motion override", () => {
    expect(motionTokens.pushIn).toBe("280ms");
    expect(themeStyleSheet()).toContain("--wl-motion-push-in:280ms");
    expect(themeStyleSheet()).toContain("--wl-motion-push-in:0ms");
  });
});

describe("theme controller", () => {
  it("follows live system changes until a theme is fixed", () => {
    const media = new FakeMedia(false);
    const controller = installTheme(document, media);
    expect(document.documentElement.dataset.theme).toBe("lounge");

    media.change(true);
    expect(document.documentElement.dataset.theme).toBe("lounge-night");

    controller.setPreference(themes[0]?.id ?? "system");
    media.change(true);
    expect(document.documentElement.dataset.theme).toBe("lounge");
    controller.dispose();
  });

  it("removes its system listener and token sheet", () => {
    const media = new FakeMedia(false);
    const remove = vi.spyOn(media, "removeEventListener");
    const controller = installTheme(document, media);

    controller.dispose();

    expect(remove).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-theme-tokens]")).toBeNull();
  });
});
