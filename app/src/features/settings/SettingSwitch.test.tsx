import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { SettingSwitch } from "./SettingSwitch";

function setup(checked: boolean | undefined) {
  const onChange = vi.fn();
  render(() => (
    <>
      <span id="label">Show unread in the tab</span>
      <span id="description">Turns the tab icon red.</span>
      <SettingSwitch
        checked={checked}
        describedBy="description"
        labelledBy="label"
        onChange={onChange}
      />
    </>
  ));
  return { onChange, control: screen.getByRole("switch") };
}

describe("SettingSwitch", () => {
  it("is a labelled, described switch that asks to turn off when on", () => {
    const { control, onChange } = setup(true);

    expect(control).toHaveAccessibleName("Show unread in the tab");
    expect(control).toHaveAccessibleDescription("Turns the tab icon red.");
    expect(control).toBeChecked();
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("asks to turn on when off", () => {
    const { control, onChange } = setup(false);

    expect(control).not.toBeChecked();
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("is disabled until its value is known", () => {
    const { control, onChange } = setup(undefined);

    expect(control).toBeDisabled();
    expect(control).not.toBeChecked();
    fireEvent.click(control);
    expect(onChange).not.toHaveBeenCalled();
  });
});
