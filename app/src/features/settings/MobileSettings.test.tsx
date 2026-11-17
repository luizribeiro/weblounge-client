import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { switchesOn } from "../../engine/app-settings-fixture";
import { installPlatformEnvironment } from "../../platform/environment";
import { MobileSettings, type MobileSettingsPage } from "./MobileSettings";

function setup(page: MobileSettingsPage) {
  const onBack = vi.fn();
  const onOpenPage = vi.fn();
  render(() => (
    <MobileSettings
      onBack={onBack}
      onChange={() => {}}
      onOpenPage={onOpenPage}
      page={page}
      settings={{
        theme: "system",
        message_density: "comfortable",
        ...switchesOn,
      }}
    />
  ));
  return { onBack, onOpenPage };
}

describe("MobileSettings", () => {
  it("lists Appearance with its current values and opens its page", () => {
    const { onBack, onOpenPage } = setup("root");

    expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: /^Appearance\s*System · Comfortable$/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));

    expect(onOpenPage).toHaveBeenCalledWith("appearance");
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("lists Notifications with the tab indicator's state and opens its page", () => {
    const { onOpenPage } = setup("root");

    expect(
      [...document.querySelectorAll("[data-section]")].map(
        (row) => (row as HTMLElement).dataset.section,
      ),
    ).toEqual(["appearance", "notifications"]);
    fireEvent.click(
      screen.getByRole("button", {
        name: /^Notifications\s*Unread in the tab$/,
      }),
    );

    expect(onOpenPage).toHaveBeenCalledWith("notifications");
  });

  it("leaves Notifications out where no notification setting applies", () => {
    installPlatformEnvironment(document.body, window, {
      target: "tauri-mobile",
    });
    setup("root");

    expect(screen.getByRole("button", { name: /^Appearance/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
  });

  it("falls back to the root for a page hidden on this platform", () => {
    installPlatformEnvironment(document.body, window, {
      target: "tauri-mobile",
    });
    setup("notifications");

    expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows the tab switch on the Notifications page", () => {
    setup("notifications");

    expect(
      screen.getByRole("heading", { name: "Notifications" }),
    ).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Show unread in the tab" }),
    ).toBeChecked();
  });

  it("lists Appearance before the engine has answered", () => {
    render(() => (
      <MobileSettings
        onBack={() => {}}
        onChange={() => {}}
        onOpenPage={() => {}}
        page="root"
        settings={undefined}
      />
    ));

    expect(screen.getByRole("button", { name: "Appearance" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Settings" })).toBeVisible();
  });

  it("shows the Appearance controls in the phone layout", () => {
    const { onBack } = setup("appearance");

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeVisible();
    expect(
      screen
        .getByRole("radiogroup", { name: "Theme" })
        .closest("[data-settings-layout]"),
    ).toHaveAttribute("data-settings-layout", "phone");
    fireEvent.click(screen.getByRole("button", { name: "Back to Settings" }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
