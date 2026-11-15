import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { MobileSheet } from "./MobileSheet";

it("traps focus and dismisses a modal phone sheet", async () => {
  const dismiss = vi.fn();
  render(() => (
    <MobileSheet label="Chat actions" onDismiss={dismiss}>
      <button data-initial-focus type="button">
        First
      </button>
      <button type="button">Last</button>
    </MobileSheet>
  ));
  await Promise.resolve();
  const dialog = screen.getByRole("dialog", { name: "Chat actions" });
  const first = screen.getByRole("button", { name: "First" });
  const last = screen.getByRole("button", { name: "Last" });
  expect(first).toHaveFocus();
  first.focus();
  fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
  expect(last).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(dismiss).toHaveBeenCalledOnce();
});

it("keeps a sheet's search field inside its Tab cycle", async () => {
  render(() => (
    <MobileSheet label="Message actions" onDismiss={() => undefined}>
      <button data-initial-focus type="button">
        React
      </button>
      <input aria-label="Search emoji" type="search" />
    </MobileSheet>
  ));
  await Promise.resolve();
  const dialog = screen.getByRole("dialog", { name: "Message actions" });
  const search = screen.getByRole("searchbox", { name: "Search emoji" });
  search.focus();

  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(screen.getByRole("button", { name: "React" })).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
  expect(search).toHaveFocus();
});
