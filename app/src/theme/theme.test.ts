import { describe, expect, it } from "vitest";
import { installTheme } from "./theme-controller";
import {
  motionTokens,
  nickPaletteSize,
  themeStyleSheet,
  themes,
} from "./theme-registry";

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
    expect(motionTokens.suggestions).toBe("120ms");
    expect(themeStyleSheet()).toContain("--wl-motion-push-in:280ms");
    expect(themeStyleSheet()).toContain("--wl-motion-push-in:0ms");
    expect(themeStyleSheet()).toContain("--wl-motion-suggestions:0ms");
  });
});

describe("theme controller", () => {
  it("follows live system changes until a theme is fixed", () => {
    const controller = installTheme(document, false);
    expect(document.documentElement.dataset.theme).toBe("lounge");

    controller.setSystemDark(true);
    expect(document.documentElement.dataset.theme).toBe("lounge-night");

    controller.setPreference(themes[0]?.id ?? "system");
    controller.setSystemDark(true);
    expect(document.documentElement.dataset.theme).toBe("lounge");
    controller.dispose();
  });

  it("removes its token sheet", () => {
    const controller = installTheme(document, false);

    controller.dispose();

    expect(document.querySelector("[data-theme-tokens]")).toBeNull();
  });
});
