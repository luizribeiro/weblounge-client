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
import type {
  NotificationSwitch,
  PageSwitchStatus,
  PushSettings,
  PushSwitchStatus,
} from "./push-settings";

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

function pushSwitch(
  status: PushSwitchStatus | undefined,
  overrides: Partial<PushSettings> = {},
): NotificationSwitch {
  return {
    kind: "push",
    push: {
      status,
      blockedIn: "browser",
      onToggle: vi.fn(),
      onRetry: vi.fn(),
      onOpenSystemSettings: undefined,
      ...overrides,
    },
  };
}

function pageSwitch(
  status: PageSwitchStatus | undefined,
  onToggle: (on: boolean) => void = vi.fn(),
): NotificationSwitch {
  return { kind: "page", page: { status, blockedIn: "macos", onToggle } };
}

const pageToggle = () => screen.getByRole("switch", { name: "Notifications" });

const pushToggle = () =>
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
        notifications={pushSwitch("on")}
        settings={loaded}
      />
    ));

    expect(screen.getByRole("heading", { name: "This device" })).toBeVisible();
    expect(pushToggle()).toBeChecked();
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
        notifications={pushSwitch(status(), { onToggle })}
        settings={loaded}
      />
    ));

    expect(pushToggle()).not.toBeChecked();
    expect(pushToggle()).toHaveAccessibleDescription(
      "Get notified about direct messages and mentions on this device.",
    );
    fireEvent.click(pushToggle());
    expect(onToggle).toHaveBeenLastCalledWith(true);
    setStatus("on");
    fireEvent.click(pushToggle());
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
        notifications={pushSwitch("blocked", {
          blockedIn: "ios",
          onOpenSystemSettings: opener(),
        })}
        settings={loaded}
      />
    ));

    expect(pushToggle()).not.toBeChecked();
    expect(pushToggle()).toBeDisabled();
    expect(pushToggle()).toHaveAccessibleDescription(
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
        notifications={pushSwitch("blocked")}
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
        notifications={pushSwitch("failed", { onRetry })}
        settings={loaded}
      />
    ));

    expect(pushToggle()).toBeChecked();
    expect(pushToggle()).toHaveAccessibleDescription(
      /Couldn't turn on notifications/u,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("turns page notifications on and off where push isn't available", () => {
    installTarget("tauri-desktop");
    const [status, setStatus] = createSignal<PageSwitchStatus>("on");
    const onToggle = vi.fn();
    render(() => (
      <NotificationsSettings
        onChange={vi.fn()}
        notifications={pageSwitch(status(), onToggle)}
        settings={loaded}
      />
    ));

    expect(screen.getByRole("heading", { name: "This device" })).toBeVisible();
    expect(pageToggle()).toBeChecked();
    expect(pageToggle()).toHaveAccessibleDescription(
      "Show a notification for direct messages and mentions while weblounge is open.",
    );
    expect(
      screen.queryByRole("switch", { name: "Push notifications" }),
    ).toBeNull();
    fireEvent.click(pageToggle());
    expect(onToggle).toHaveBeenLastCalledWith(false);
    setStatus("off");
    expect(pageToggle()).not.toBeChecked();
    fireEvent.click(pageToggle());
    expect(onToggle).toHaveBeenLastCalledWith(true);
  });

  it("names System Settings when the Mac blocks page notifications", () => {
    installTarget("tauri-desktop");
    render(() => (
      <NotificationsSettings
        onChange={vi.fn()}
        notifications={pageSwitch("blocked")}
        settings={loaded}
      />
    ));

    expect(pageToggle()).toBeDisabled();
    expect(pageToggle()).toHaveAccessibleDescription(
      /Blocked in System Settings → Notifications → weblounge/u,
    );
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });

  it("waits for the settings before the push switch can change", () => {
    render(() => (
      <NotificationsSettings
        onChange={vi.fn()}
        notifications={pushSwitch(undefined)}
        settings={undefined}
      />
    ));

    expect(pushToggle()).toBeDisabled();
  });
});
