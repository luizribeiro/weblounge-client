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
  expect(close).toHaveBeenCalledOnce();
  expect(
    view.container.querySelector('[data-overlay-drawer="left"]'),
  ).not.toBeNull();
});
