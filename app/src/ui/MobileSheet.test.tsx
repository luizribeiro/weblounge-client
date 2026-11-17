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
  const back = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
  document.addEventListener("keydown", back);
  fireEvent.keyDown(document.body, { key: "Escape" });
  document.removeEventListener("keydown", back);
  expect(dismiss).toHaveBeenCalledOnce();
  expect(back).toHaveReturnedWith(true);
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

it("ignores the click that lifts the press opening it, then acts on later taps", () => {
  const dismiss = vi.fn();
  const react = vi.fn();
  render(() => (
    <MobileSheet label="Message actions" onDismiss={dismiss}>
      <button onClick={react} type="button">
        React
      </button>
    </MobileSheet>
  ));
  const [scrim] = screen.getAllByRole("button", { name: "Message actions" });
  if (scrim === undefined) throw new Error("the scrim is missing");
  const reaction = screen.getByRole("button", { name: "React" });

  fireEvent.click(reaction, { detail: 1 });
  fireEvent.click(scrim, { detail: 1 });
  expect(react).not.toHaveBeenCalled();
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.pointerDown(reaction);
  fireEvent.click(reaction, { detail: 1 });
  expect(react).toHaveBeenCalledOnce();
  fireEvent.pointerDown(scrim);
  fireEvent.click(scrim, { detail: 1 });
  expect(dismiss).toHaveBeenCalledOnce();
});
