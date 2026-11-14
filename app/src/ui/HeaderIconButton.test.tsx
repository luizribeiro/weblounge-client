import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { HeaderIconButton, labelWithShortcut } from "./HeaderIconButton";

describe("HeaderIconButton", () => {
  it("names the button and advertises its chord", () => {
    const onClick = vi.fn();
    render(() => (
      <HeaderIconButton
        ariaKeyShortcuts="Meta+Shift+Comma"
        data-settings-button="true"
        hasPopup="dialog"
        label="Settings"
        onClick={onClick}
        shortcut="⇧⌘,"
      >
        <svg aria-hidden="true" />
      </HeaderIconButton>
    ));
    const button = screen.getByRole("button", { name: "Settings" });

    expect(button).toHaveAttribute("title", "Settings (⇧⌘,)");
    expect(button).toHaveAttribute("aria-keyshortcuts", "Meta+Shift+Comma");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("data-size", "header");
    expect(button).toHaveAttribute("data-settings-button", "true");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("uses the bare label without a chord and grows for touch", () => {
    render(() => (
      <HeaderIconButton label="Settings" onClick={() => {}} size="touch">
        <svg aria-hidden="true" />
      </HeaderIconButton>
    ));
    const button = screen.getByRole("button", { name: "Settings" });

    expect(button).toHaveAttribute("title", "Settings");
    expect(button).not.toHaveAttribute("aria-keyshortcuts");
    expect(button).toHaveAttribute("data-size", "touch");
  });

  it("formats a label with an optional chord", () => {
    expect(labelWithShortcut("Jump to", "⌘K")).toBe("Jump to (⌘K)");
    expect(labelWithShortcut("Jump to", undefined)).toBe("Jump to");
  });
});
