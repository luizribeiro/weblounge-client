import { afterEach, expect, it } from "vitest";
import { createRowReactions, focusControl } from "./row-reactions";

afterEach(() => {
  document.body.replaceChildren();
});

function row(key: string): HTMLElement {
  const element = document.createElement("div");
  const button = document.createElement("button");
  button.dataset.focusKey = key;
  element.append(button);
  document.body.append(element);
  return element;
}

it("toggles and names the focused control for the re-rendered row", () => {
  const toggled: [number, string][] = [];
  const reactions = createRowReactions((id, reaction) =>
    toggled.push([id, reaction]),
  );
  row("toolbar:👍").querySelector("button")?.focus();

  reactions.toggle(4, "👍");
  document.body.replaceChildren();

  expect(toggled).toEqual([[4, "👍"]]);
  expect(reactions.focusToRestore(5)).toBeUndefined();
  expect(reactions.focusToRestore(4)).toBe("toolbar:👍");
  expect(reactions.focusToRestore(4)).toBe("toolbar:👍");
});

it("forgets the control once the user has moved focus", () => {
  const reactions = createRowReactions(() => undefined);
  row("chip:🎉").querySelector("button")?.focus();
  reactions.toggle(4, "🎉");
  document.body.replaceChildren();
  row("composer").querySelector("button")?.focus();

  expect(reactions.focusToRestore(4)).toBeUndefined();
  document.body.replaceChildren();
  expect(reactions.focusToRestore(4)).toBeUndefined();
});

it("restores nothing after a pointer toggle", () => {
  const reactions = createRowReactions(() => undefined);

  reactions.toggle(4, "👍");

  expect(reactions.focusToRestore(4)).toBeUndefined();
});

it("focuses the control with the matching key", () => {
  const target = row("chip:👍");

  focusControl(target, "chip:👍");

  expect(document.activeElement).toBe(target.querySelector("button"));
});
