import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { expect, it } from "vitest";
import { OmnibarOverlay } from "./OmnibarOverlay";

it("exposes combobox semantics, traps focus, and restores the invoker", async () => {
  const [open, setOpen] = createSignal(false);
  render(() => (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open switcher
      </button>
      <Show when={open()}>
        <OmnibarOverlay
          activeDescendant="buffer-option-1"
          inputLabel="Jump to"
          label="Quick switcher"
          listboxId="buffer-results"
          onDismiss={() => setOpen(false)}
          onInput={() => {}}
          placeholder="Jump to a channel or person"
          query=""
        >
          <div id="buffer-results" role="listbox">
            <div id="buffer-option-1" role="option" tabIndex={-1}>
              #general
            </div>
          </div>
        </OmnibarOverlay>
      </Show>
    </>
  ));
  const launcher = screen.getByRole("button", { name: "Open switcher" });
  launcher.focus();
  fireEvent.click(launcher);
  const input = screen.getByRole("combobox", { name: "Jump to" });
  await waitFor(() => expect(input).toHaveFocus());
  expect(input).toHaveAttribute("aria-controls", "buffer-results");
  expect(input).toHaveAttribute("aria-activedescendant", "buffer-option-1");
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveFocus();
  fireEvent.keyDown(input, { key: "Escape" });
  await Promise.resolve();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(launcher).toHaveFocus();
});
