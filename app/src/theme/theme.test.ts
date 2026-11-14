import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import loungeNight from "../../themes/lounge-night.json";
import { themePreferences } from "../engine/decodeSettings";
import { resolveTheme } from "./resolve-theme";
import { installTheme } from "./theme-controller";
import {
  buildRegistry,
  motionTokens,
  nickPaletteSize,
  themeStyleSheet,
  themes,
  timeTokens,
} from "./theme-registry";

describe("theme registry", () => {
  it("loads Lounge themes and emits their tokens", () => {
    expect(themes.map((theme) => theme.id)).toEqual(["lounge", "lounge-night"]);
    expect(themes[0]?.nickPalette).toHaveLength(6);
    expect(nickPaletteSize).toBe(6);
    expect(themeStyleSheet()).toContain("--wl-color-bg:#f3f1e9");
    expect(themeStyleSheet()).toContain("--wl-color-bg:#18221e");
    expect(themeStyleSheet()).toContain(
      "--wl-color-overlay-scrim:rgba(0,0,0,.28)",
    );
    expect(themeStyleSheet()).toContain(
      "--wl-color-overlay-scrim:rgba(0,0,0,.48)",
    );
    for (const theme of ["lounge", "lounge-night"]) {
      const block = themeStyleSheet()
        .split(`[data-theme="${theme}"]`)[1]
        ?.split("}")[0];
      expect(block).toContain("--wl-color-viewer-scrim:rgba(0,0,0,.92)");
      expect(block).toContain("--wl-color-viewer-fg:#edefe5");
    }
    expect(themeStyleSheet()).toContain(
      "--wl-font-title:Inter, Inter Fallback, system-ui, sans-serif",
    );
    expect(themeStyleSheet()).toContain("--wl-radius-icon:6px");
    expect(themes[1]?.onboarding).not.toHaveProperty("soft");
    expect(themes[1]?.onboarding).not.toHaveProperty("signal");
    expect(
      compactCss(readFileSync("src/styles/theme-tokens.css", "utf8")),
    ).toBe(compactCss(themeStyleSheet()));
  });

  it("owns motion tokens and their reduced-motion override", () => {
    expect(motionTokens.drawerCurve).toBe("cubic-bezier(0.2, 0.9, 0.25, 1)");
    expect(motionTokens.drawerOpen).toBe("340ms");
    expect(motionTokens.drawerClose).toBe("260ms");
    expect(motionTokens.connection).toBe("1400ms");
    expect(motionTokens.pop).toBe("280ms");
    expect(motionTokens.popCurve).toBe("cubic-bezier(0.25, 0.46, 0.45, 0.94)");
    expect(motionTokens.pushCurve).toBe("cubic-bezier(0.2, 0.9, 0.25, 1)");
    expect(motionTokens.pushIn).toBe("280ms");
    expect(motionTokens.suggestions).toBe("120ms");
    expect(themeStyleSheet()).toContain("--wl-motion-push-in:280ms");
    expect(themeStyleSheet()).toContain("--wl-motion-push-in:0ms");
    expect(themeStyleSheet()).toContain("--wl-motion-suggestions:0ms");
    expect(themeStyleSheet()).toContain("--wl-motion-drawer-open:0ms");
    expect(themeStyleSheet()).not.toContain("--wl-motion-drawer-curve:0ms");
    expect(themeStyleSheet()).not.toContain("--wl-motion-push-curve:0ms");
    expect(themeStyleSheet()).not.toContain("--wl-motion-pop-curve:0ms");
  });

  it("keeps time tokens when motion is reduced, since a hold delay is not motion", () => {
    expect(timeTokens.hintHold).toBe("400ms");
    expect(themeStyleSheet()).toContain("--wl-time-hint-hold:400ms");
    expect(themeStyleSheet()).not.toContain("--wl-time-hint-hold:0ms");
  });
});

describe("theme schema", () => {
  const { onboarding: _onboarding, ...withoutOnboarding } = loungeNight;

  it("accepts a theme without onboarding tokens", () => {
    const [theme] = buildRegistry({ "night.json": withoutOnboarding });

    expect(theme?.id).toBe("lounge-night");
    expect(theme).not.toHaveProperty("onboarding");
  });

  it("rejects unknown keys and missing tokens", () => {
    expect(() =>
      buildRegistry({ "night.json": { ...loungeNight, extra: true } }),
    ).toThrow("night.json: expected");
    const { accent: _accent, ...colors } = loungeNight.colors;
    expect(() =>
      buildRegistry({ "night.json": { ...loungeNight, colors } }),
    ).toThrow("night.json.colors: expected");
    expect(() =>
      buildRegistry({ "night.json": { ...loungeNight, onboarding: {} } }),
    ).toThrow("night.json.onboarding: expected");
  });
});

function compactCss(value: string): string {
  return value
    .replaceAll(/\s+/g, "")
    .replaceAll(/([(:,])0\./g, "$1.")
    .replaceAll(";}", "}");
}

describe("theme controller", () => {
  it("follows live system changes until a theme is fixed", () => {
    const controller = installTheme(document, false);
    expect(document.documentElement.dataset.theme).toBe("lounge");

    controller.setSystemDark(true);
    expect(document.documentElement.dataset.theme).toBe("lounge-night");

    controller.setPreference("lounge");
    controller.setSystemDark(true);
    expect(document.documentElement.dataset.theme).toBe("lounge");
    controller.dispose();
  });

  it("starts from a remembered preference", () => {
    installTheme(document, false, "lounge-night");

    expect(document.documentElement.dataset.theme).toBe("lounge-night");
  });

  it("keeps a remembered fixed theme when the system changes", () => {
    const controller = installTheme(document, false, "lounge-night");

    controller.setSystemDark(true);
    controller.setSystemDark(false);

    expect(document.documentElement.dataset.theme).toBe("lounge-night");
  });

  it("registers every theme the engine can store", () => {
    for (const preference of themePreferences) {
      for (const systemDark of [false, true]) {
        const theme = resolveTheme(preference, systemDark);
        expect(themes.map((candidate) => candidate.id)).toContain(theme);
      }
    }
  });

  it("resolves System by appearance and fixed themes to themselves", () => {
    expect(resolveTheme("system", false)).toBe("lounge");
    expect(resolveTheme("system", true)).toBe("lounge-night");
    expect(resolveTheme("lounge", true)).toBe("lounge");
    expect(resolveTheme("lounge-night", false)).toBe("lounge-night");
  });

  it("can be disposed after installation", () => {
    const controller = installTheme(document, false);

    controller.dispose();

    expect(document.documentElement.dataset.theme).toBe("lounge");
  });
});
