import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { SettingsModal } from "./SettingsModal";

function setup() {
  const onClose = vi.fn();
  const onChange = vi.fn();
  render(() => (
    <SettingsModal
      onChange={onChange}
      onClose={onClose}
      settings={{ theme: "system", message_density: "cozy" }}
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

  it("wraps Tab between the checked density and Close", async () => {
    const { dialog } = setup();
    await waitFor(() => expect(dialog).toHaveFocus());
    const cozy = screen.getByRole("radio", { name: "Cozy" });

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(cozy).toHaveFocus();
    fireEvent.keyDown(cozy, { key: "Tab" });

    expect(
      screen.getByRole("button", { name: "Close settings" }),
    ).toHaveFocus();
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
