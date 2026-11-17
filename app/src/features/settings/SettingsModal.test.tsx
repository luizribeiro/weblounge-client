import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { installPlatformEnvironment } from "../../platform/environment";
import { SettingsModal } from "./SettingsModal";

function setup(rail = false) {
  const onClose = vi.fn();
  const onChange = vi.fn();
  render(() => (
    <SettingsModal
      onChange={onChange}
      onClose={onClose}
      rail={rail}
      settings={{
        theme: "system",
        message_density: "cozy",
        unread_tab_indicator: true,
        push_on_this_device: true,
      }}
    />
  ));
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  return { dialog, onChange, onClose };
}

describe("SettingsModal", () => {
  it("is a labelled modal dialog that takes focus", async () => {
    const { dialog } = setup();

    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(
      screen.getByRole("navigation", { name: "Settings sections" }),
    ).toContainElement(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("region", { name: "Appearance" })).toContainElement(
      screen.getByRole("radiogroup", { name: "Theme" }),
    );
  });

  it("closes from Escape and from the Close button", () => {
    const { dialog, onClose } = setup();

    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("collapses the expanded rail on Escape before closing", () => {
    const { dialog, onClose } = setup(true);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    screen.getByRole("button", { name: "Appearance" }).focus();
    expect(nav).toHaveAttribute("data-expanded");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(nav).not.toHaveAttribute("data-expanded");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape once the window widens past the rail", () => {
    const onClose = vi.fn();
    const [rail, setRail] = createSignal(true);
    render(() => (
      <SettingsModal
        onChange={() => {}}
        onClose={onClose}
        rail={rail()}
        settings={{
          theme: "system",
          message_density: "cozy",
          unread_tab_indicator: true,
          push_on_this_device: true,
        }}
      />
    ));
    screen.getByRole("button", { name: "Appearance" }).focus();
    setRail(false);

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Settings" }), {
      key: "Escape",
    });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the Notifications page from its nav item", () => {
    setup();
    const notifications = screen.getByRole("button", { name: "Notifications" });

    fireEvent.click(notifications);

    expect(notifications).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: "Appearance" }),
    ).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("region", { name: "Appearance" })).toBeNull();
    expect(
      screen.getByRole("region", { name: "Notifications" }),
    ).toContainElement(
      screen.getByRole("switch", { name: "Show unread in the tab" }),
    );
  });

  it("lists only Appearance where no notification setting applies", () => {
    installPlatformEnvironment(document.body, window, {
      target: "tauri-desktop",
    });
    setup();

    expect(
      screen
        .getByRole("navigation", { name: "Settings sections" })
        .querySelectorAll("button"),
    ).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
  });

  it("wraps Tab between the last switch and Close", async () => {
    const { dialog } = setup();
    await waitFor(() => expect(dialog).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    dialog.focus();
    const last = screen.getByRole("switch", { name: "Show unread in the tab" });

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });

    expect(
      screen.getByRole("button", { name: "Close settings" }),
    ).toHaveFocus();
  });

  it("closes on Escape after flipping a switch", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    const tabSwitch = screen.getByRole("switch", {
      name: "Show unread in the tab",
    });

    tabSwitch.focus();
    fireEvent.click(tabSwitch);
    fireEvent.keyDown(tabSwitch, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("passes setting changes through", () => {
    const { onChange } = setup();

    fireEvent.click(screen.getByRole("radio", { name: "Lounge" }));

    expect(onChange).toHaveBeenCalledWith({
      scope: "app",
      setting: { key: "theme", value: "lounge" },
    });
  });
});
