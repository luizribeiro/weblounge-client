import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { ErrorDialog } from "./ErrorDialog";

function renderDialog() {
  const onDismiss = vi.fn();
  render(() => (
    <ErrorDialog
      explanation="Only images can be sent."
      message="Can’t attach archive.zip"
      onDismiss={onDismiss}
    />
  ));
  return { onDismiss, ok: screen.getByRole("button", { name: "OK" }) };
}

it("names the problem, explains it and focuses OK", () => {
  const { ok } = renderDialog();
  const dialog = screen.getByRole("alertdialog", {
    name: "Can’t attach archive.zip",
  });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(screen.getByText("Only images can be sent.")).toBeTruthy();
  expect(document.activeElement).toBe(ok);
});

it("dismisses on OK and on Escape", () => {
  const { onDismiss, ok } = renderDialog();
  fireEvent.click(ok);
  expect(onDismiss).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
  expect(onDismiss).toHaveBeenCalledTimes(2);
});

it("keeps Tab on its only button, both ways", () => {
  const { ok } = renderDialog();
  for (const shiftKey of [false, true]) {
    fireEvent.keyDown(ok, { key: "Tab", shiftKey });
    expect(document.activeElement).toBe(ok);
  }
});
