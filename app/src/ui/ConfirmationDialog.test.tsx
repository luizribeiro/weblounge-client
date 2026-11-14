import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { ConfirmationDialog } from "./ConfirmationDialog";

function renderDialog(remember?: string) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(() => (
    <ConfirmationDialog
      action="Upload"
      explanation="It receives your account name and password."
      label="Allow upload to files.elsewhere.test"
      message="Send your password to files.elsewhere.test?"
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...(remember === undefined ? {} : { remember })}
    />
  ));
  return { onCancel, onConfirm };
}

it("shows its explanation and focuses Cancel", () => {
  renderDialog();
  expect(
    screen.getByText("It receives your account name and password."),
  ).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByText("Cancel"));
  expect(screen.queryByRole("checkbox")).toBeNull();
});

it("passes the remember choice to onConfirm", () => {
  const { onConfirm } = renderDialog("Remember for this network");
  fireEvent.click(screen.getByText("Upload"));
  fireEvent.click(screen.getByLabelText("Remember for this network"));
  fireEvent.click(screen.getByText("Upload"));
  expect(onConfirm.mock.calls).toEqual([[false], [true]]);
});

it("keeps Tab inside the dialog, through the checkbox, both ways", () => {
  renderDialog("Remember for this network");
  const dialog = screen.getByRole("alertdialog");
  const order = [
    screen.getByText("Cancel"),
    screen.getByRole("checkbox"),
    screen.getByText("Upload"),
  ];
  for (const next of [order[1], order[2], order[0]]) {
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Tab" });
    expect(document.activeElement).toBe(next);
  }
  fireEvent.keyDown(document.activeElement ?? dialog, {
    key: "Tab",
    shiftKey: true,
  });
  expect(document.activeElement).toBe(order[2]);
});

it("cancels on Escape", () => {
  const { onCancel, onConfirm } = renderDialog();
  fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
});
