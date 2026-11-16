import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../engine/generated/AppSettings";
import { NotificationsSettings } from "./NotificationsSettings";

const loaded: AppSettings = {
  theme: "lounge-night",
  message_density: "compact",
  unread_tab_indicator: true,
};

describe("NotificationsSettings", () => {
  it("turns the unread tab indicator off and on from its switch", () => {
    const onChange = vi.fn();
    const [settings, setSettings] = createSignal(loaded);
    render(() => (
      <NotificationsSettings onChange={onChange} settings={settings()} />
    ));
    const tabSwitch = screen.getByRole("switch", {
      name: "Show unread in the tab",
    });

    expect(screen.getByRole("heading", { name: "Browser tab" })).toBeVisible();
    expect(tabSwitch).toBeChecked();
    expect(tabSwitch).toHaveAccessibleDescription(
      "Turns the tab icon red and counts unread direct messages and mentions in its title.",
    );
    fireEvent.click(tabSwitch);
    expect(onChange).toHaveBeenLastCalledWith({
      scope: "app",
      setting: { key: "unread_tab_indicator", value: false },
    });

    setSettings({ ...loaded, unread_tab_indicator: false });
    expect(tabSwitch).not.toBeChecked();
    fireEvent.click(tabSwitch);
    expect(onChange).toHaveBeenLastCalledWith({
      scope: "app",
      setting: { key: "unread_tab_indicator", value: true },
    });
  });

  it("disables the switch before the engine answers", () => {
    render(() => (
      <NotificationsSettings onChange={vi.fn()} settings={undefined} />
    ));

    expect(
      screen.getByRole("switch", { name: "Show unread in the tab" }),
    ).toBeDisabled();
  });
});
