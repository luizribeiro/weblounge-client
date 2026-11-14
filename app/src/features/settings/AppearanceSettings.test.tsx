import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../engine/generated/AppSettings";
import { themes } from "../../theme/theme-registry";
import { AppearanceSettings } from "./AppearanceSettings";

function setup(
  initial: AppSettings = {
    theme: "system",
    message_density: "cozy",
  },
) {
  const onChange = vi.fn();
  const [settings, setSettings] = createSignal(initial);
  render(() => (
    <AppearanceSettings onChange={onChange} settings={settings()} />
  ));
  return { onChange, setSettings };
}

function radioNames(group: HTMLElement): string[] {
  return within(group)
    .getAllByRole("radio")
    .map(
      (radio) =>
        radio.getAttribute("aria-label") ??
        radio.closest("label")?.textContent ??
        "",
    );
}

describe("AppearanceSettings", () => {
  it("offers System and every shipped theme as one choice", () => {
    setup();
    const group = screen.getByRole("radiogroup", { name: "Theme" });

    expect(radioNames(group)).toEqual([
      "System",
      "Lounge",
      "Lounge Night",
      "Black",
      "Modern",
      "Terminal",
      "Retro",
    ]);
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "System" }),
    ).toHaveAccessibleDescription("Matches your device");
  });

  it("draws System from both the light and the dark theme's tokens", () => {
    setup();
    const system = screen
      .getByRole("radio", { name: "System" })
      .closest("label");
    const previews = [
      ...(system?.querySelectorAll<HTMLElement>("[data-preview-theme]") ?? []),
    ];

    expect(previews.map((preview) => preview.dataset.previewTheme)).toEqual([
      "lounge",
      "lounge-night",
    ]);
    expect(
      previews.map((preview) =>
        preview.style.getPropertyValue("--wl-preview-surface"),
      ),
    ).toEqual(
      ["lounge", "lounge-night"].map(
        (id) => themes.find((theme) => theme.id === id)?.colors.bg,
      ),
    );
  });

  it("previews and describes each fixed theme in its own colours", () => {
    setup();

    for (const theme of themes) {
      const radio = screen.getByRole("radio", { name: theme.name });
      expect(radio).toHaveAccessibleDescription(theme.description);
      const card = radio.closest("label");
      const previews = [
        ...(card?.querySelectorAll<HTMLElement>("[data-preview-theme]") ?? []),
      ];
      expect(previews.map((preview) => preview.dataset.previewTheme)).toEqual([
        theme.id,
      ]);
      expect(previews[0]?.style.getPropertyValue("--wl-preview-panel")).toBe(
        theme.colors.panel,
      );
    }
  });

  it("asks the engine to change the theme when a card is chosen", () => {
    const { onChange } = setup();

    fireEvent.click(screen.getByRole("radio", { name: "Lounge Night" }));

    expect(onChange).toHaveBeenCalledWith({
      scope: "app",
      setting: { key: "theme", value: "lounge-night" },
    });
  });

  it("changes the density from its labelled radio group", () => {
    const { onChange } = setup();
    const group = screen.getByRole("radiogroup", { name: "Message density" });

    expect(group).toHaveAccessibleDescription(
      "Spacing, text size and avatar size in the conversation.",
    );
    expect(radioNames(group)).toEqual(["Compact", "Cozy", "Comfortable"]);
    fireEvent.click(screen.getByRole("radio", { name: "Comfortable" }));

    expect(onChange).toHaveBeenCalledWith({
      scope: "app",
      setting: { key: "message_density", value: "comfortable" },
    });
  });

  it("keeps each control's choices in their own group", () => {
    setup();
    const names = (group: string) =>
      new Set(
        within(screen.getByRole("radiogroup", { name: group }))
          .getAllByRole("radio")
          .map((radio) => (radio as HTMLInputElement).name),
      );

    const themeNames = names("Theme");
    const densityNames = names("Message density");

    expect(themeNames.size).toBe(1);
    expect(densityNames.size).toBe(1);
    expect([...themeNames][0]).not.toBe([...densityNames][0]);
  });

  it("follows the engine's values as they change", () => {
    const { setSettings } = setup({
      theme: "lounge",
      message_density: "compact",
    });
    expect(screen.getByRole("radio", { name: "Lounge" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Compact" })).toBeChecked();

    setSettings({ theme: "lounge-night", message_density: "comfortable" });

    expect(screen.getByRole("radio", { name: "Lounge Night" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Lounge" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Comfortable" })).toBeChecked();
  });

  it("checks nothing before the engine answers", () => {
    render(() => (
      <AppearanceSettings onChange={vi.fn()} settings={undefined} />
    ));

    for (const radio of screen.getAllByRole("radio"))
      expect(radio).not.toBeChecked();
  });
});
