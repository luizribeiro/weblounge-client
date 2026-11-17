import { render } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { ChordHint } from "./ChordHint";

function caps(label: string): readonly HTMLElement[] {
  const { container } = render(() => <ChordHint label={label} />);
  return [...container.querySelectorAll<HTMLElement>("kbd kbd")];
}

it("draws each key of a macOS chord as its own cap", () => {
  const keys = caps("⇧⌘P");

  expect(keys.map((key) => key.textContent)).toEqual(["⇧", "⌘", "P"]);
  expect(keys.map((key) => key.dataset.modifier)).toEqual([
    "true",
    "true",
    "false",
  ]);
});

it("draws Ctrl, Shift and the key as separate caps on other platforms", () => {
  const keys = caps("Ctrl+Shift+,");

  expect(keys.map((key) => key.textContent)).toEqual(["Ctrl", "Shift", ","]);
  expect(keys.map((key) => key.dataset.glyph)).toEqual([
    "false",
    "false",
    "true",
  ]);
});

it("hides the caps from assistive tech and reads the chord as written", () => {
  const { container } = render(() => <ChordHint label="⌥⌘S" />);

  expect(container.querySelector(".visually-hidden")).toHaveTextContent(
    /^⌥⌘S$/u,
  );
  const caps = container.querySelector("[aria-hidden='true']");
  expect(caps?.querySelectorAll("kbd")).toHaveLength(3);
});
