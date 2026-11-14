import { afterEach, describe, expect, it } from "vitest";
import { returnFocus } from "./focus-return";

function button(): HTMLButtonElement {
  const element = document.createElement("button");
  document.body.append(element);
  return element;
}

describe("returnFocus", () => {
  afterEach(() => document.body.replaceChildren());

  it("focuses an invoker that is still on the page", () => {
    const invoker = button();

    expect(returnFocus(invoker)).toBe(true);
    expect(document.activeElement).toBe(invoker);
  });

  it("declines an invoker that was removed, made inert or was the page", () => {
    const removed = button();
    removed.remove();
    const inert = button();
    inert.parentElement?.setAttribute("inert", "");

    expect(returnFocus(removed)).toBe(false);
    expect(returnFocus(inert)).toBe(false);
    expect(returnFocus(document.body)).toBe(false);
    expect(returnFocus(null)).toBe(false);
  });
});
