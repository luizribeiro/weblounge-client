import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { switchesOn } from "../../engine/app-settings-fixture";
import type { AppSettings } from "../../engine/generated/AppSettings";
import {
  installPlatformEnvironment,
  type PlatformTarget,
} from "../../platform/environment";
import { NotificationsSettings } from "./NotificationsSettings";
import type { PushSettings, PushSwitchStatus } from "./push-settings";

const loaded: AppSettings = {
  theme: "lounge-night",
  message_density: "compact",
  ...switchesOn,
};

function installTarget(target: PlatformTarget): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  installPlatformEnvironment(document.body, window, { target });
}

function pushSettings(
  status: PushSwitchStatus | undefined,
  overrides: Partial<PushSettings> = {},
): PushSettings {
  return {
    status,
    blockedIn: "browser",
    onToggle: vi.fn(),
    onRetry: vi.fn(),
    onOpenSystemSettings: undefined,
    ...overrides,
  };
}

const pushSwitch = () =>
  screen.getByRole("switch", { name: "Push notifications" });

describe("NotificationsSettings", () => {
  beforeEach(() => installTarget("web"));

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

  it("shows the tab row only in a browser tab, and push only where it works", () => {
    installTarget("tauri-mobile");
    render(() => (
      <NotificationsSettings
        onChange={vi.fn()}
        push={pushSettings("on")}
        settings={loaded}
      />
    ));

    expect(screen.getByRole("heading", { name: "This device" })).toBeVisible();
    expect(pushSwitch()).toBeChecked();
    expect(
      screen.queryByRole("switch", { name: "Show unread in the tab" }),
    ).toBeNull();
  });

  it("turns push on and off through the switch", () => {
    const [status, setStatus] = createSignal<PushSwitchStatus>("off");
    const onToggle = vi.fn();
    render(() => (
      <NotificationsSettings
        onChange={vi.fn()}
        push={pushSettings(status(), { onToggle })}
        settings={loaded}
      />
    ));

    expect(pushSwitch()).not.toBeChecked();
    expect(pushSwitch()).toHaveAccessibleDescription(
      "Get notified about direct messages and mentions on this device.",
    );
    fireEvent.click(pushSwitch());
    expect(onToggle).toHaveBeenLastCalledWith(true);
    setStatus("on");
    fireEvent.click(pushSwitch());
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it("explains a block and offers Open Settings only when the shell can", () => {
    const onOpenSystemSettings = vi.fn();
    const [opener, setOpener] = createSignal<(() => void) | undefined>(
      onOpenSystemSettings,
    );
    render(() => (
      <NotificationsSettings
        onChange={vi.fn()}
        push={pushSettings("blocked", {
          blockedIn: "ios",
          onOpenSystemSettings: opener(),
        })}
        settings={loaded}
      />
    ));

    expect(pushSwitch()).not.toBeChecked();
    expect(pushSwitch()).toBeDisabled();
    expect(pushSwitch()).toHaveAccessibleDescription(
      /Blocked in iOS Settings → Notifications → weblounge/u,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onOpenSystemSettings).toHaveBeenCalledOnce();
    setOpener(undefined);
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });

  it("names where to unblock on a desktop browser", () => {
    render(() => (
      <NotificationsSettings
        onChange={vi.fn()}
        push={pushSettings("blocked")}
        settings={loaded}
      />
    ));

    expect(
      screen.getByText("Blocked in this site's browser settings"),
    ).toBeVisible();
  });

  it("says a failed registration out loud and retries on request", () => {
    const onRetry = vi.fn();
    render(() => (
      <NotificationsSettings
        onChange={vi.fn()}
        push={pushSettings("failed", { onRetry })}
        settings={loaded}
      />
    ));

    expect(pushSwitch()).toBeChecked();
    expect(pushSwitch()).toHaveAccessibleDescription(
      /Couldn't turn on notifications/u,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("waits for the settings before the push switch can change", () => {
    render(() => (
      <NotificationsSettings
        onChange={vi.fn()}
        push={pushSettings(undefined)}
        settings={undefined}
      />
    ));

    expect(pushSwitch()).toBeDisabled();
  });
});
