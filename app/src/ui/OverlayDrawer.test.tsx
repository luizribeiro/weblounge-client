import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { OverlayDrawer } from "./OverlayDrawer";

it("traps focus and closes a mirrored drawer with Escape", async () => {
  const close = vi.fn();
  const view = render(() => (
    <OverlayDrawer
      closeLabel="Close channels"
      edge="left"
      label="Channels"
      onClose={close}
      width="256px"
    >
      <button type="button">First</button>
      <button type="button">Last</button>
    </OverlayDrawer>
  ));
  const dialog = screen.getByRole("dialog", { name: "Channels" });
  const first = screen.getByRole("button", { name: "First" });
  const last = screen.getByRole("button", { name: "Last" });
  await Promise.resolve();
  expect(first).toHaveFocus();

  last.focus();
  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  fireEvent(
    dialog,
    Object.assign(new Event("animationend", { bubbles: true }), {
      animationName: "drawer-out-left",
    }),
  );
  expect(close).toHaveBeenCalledOnce();
  expect(
    view.container.querySelector('[data-overlay-drawer="left"]'),
  ).not.toBeNull();
});

it("focuses its marked field without scrolling the shell behind it", async () => {
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  render(() => (
    <OverlayDrawer
      closeLabel="Close members"
      edge="right"
      label="Members"
      onClose={() => {}}
      width="300px"
    >
      <button type="button">Close</button>
      <input aria-label="Filter" data-initial-focus="true" />
    </OverlayDrawer>
  ));
  await Promise.resolve();

  expect(screen.getByRole("textbox", { name: "Filter" })).toHaveFocus();
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  focus.mockRestore();
});
