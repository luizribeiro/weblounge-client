import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { InlineConfirmation } from "./InlineConfirmation";

it("cancels on Escape without letting the surface around it close too", () => {
  const onCancel = vi.fn();
  const surfaceKeydown = vi.fn();
  render(() => (
    <div onKeyDown={surfaceKeydown} role="dialog">
      <InlineConfirmation
        action="Sign out"
        label="Sign out"
        message="Sign out of weblounge on this device?"
        onCancel={onCancel}
        onConfirm={() => {}}
      />
    </div>
  ));

  fireEvent.keyDown(screen.getByRole("button", { name: "Sign out" }), {
    key: "Escape",
  });

  expect(onCancel).toHaveBeenCalledOnce();
  expect(surfaceKeydown).not.toHaveBeenCalled();
});

it("lets other keys reach the surface around it", () => {
  const surfaceKeydown = vi.fn();
  render(() => (
    <div onKeyDown={surfaceKeydown} role="dialog">
      <InlineConfirmation
        action="Sign out"
        label="Sign out"
        message="Sign out of weblounge on this device?"
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    </div>
  ));

  fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), {
    key: "Tab",
  });

  expect(surfaceKeydown).toHaveBeenCalledOnce();
});

it("keeps focus where it was without cancelling a touch tap", () => {
  render(() => (
    <InlineConfirmation
      action="Sign out"
      label="Sign out"
      message="Sign out of weblounge on this device?"
      onCancel={() => {}}
      onConfirm={() => {}}
    />
  ));

  for (const name of ["Sign out", "Cancel"]) {
    const button = screen.getByRole("button", { name });
    expect(fireEvent.pointerDown(button)).toBe(true);
    expect(fireEvent.mouseDown(button)).toBe(false);
  }
});
