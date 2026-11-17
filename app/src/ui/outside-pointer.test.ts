import { createRoot } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { onPointerDownOutside } from "./outside-pointer";

afterEach(() => document.body.replaceChildren());

function layout() {
  const popup = document.createElement("div");
  const option = popup.appendChild(document.createElement("button"));
  const invoker = document.createElement("button");
  const elsewhere = document.createElement("main");
  document.body.append(popup, invoker, elsewhere);
  return { popup, option, invoker, elsewhere };
}

function pointerDown(target: EventTarget): void {
  target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

it("calls the handler only for presses outside every inside element", () => {
  const { popup, option, invoker, elsewhere } = layout();
  const handler = vi.fn();
  const dispose = createRoot((dispose) => {
    onPointerDownOutside(() => [popup, invoker, undefined], handler);
    return dispose;
  });

  pointerDown(option);
  pointerDown(invoker);
  expect(handler).not.toHaveBeenCalled();
  pointerDown(elsewhere);
  expect(handler).toHaveBeenCalledTimes(1);

  dispose();
  pointerDown(elsewhere);
  expect(handler).toHaveBeenCalledTimes(1);
});
