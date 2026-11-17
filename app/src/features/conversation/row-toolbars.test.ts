import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageId } from "../../engine/generated/MessageId";
import { createRowToolbars } from "./row-toolbars";

afterEach(() => document.body.replaceChildren());

function toolbarsWithMenu() {
  return createRoot(() => {
    const [menuRow, setMenuRow] = createSignal<MessageId>();
    const toolbars = createRowToolbars(menuRow);
    const rows = [1, 2, 3].map((id) => toolbars.row(id));
    const shown = () =>
      rows.flatMap((row, index) => (row.shown() ? [index + 1] : []));
    return { rows, shown, setMenuRow };
  });
}

function focusEvent(
  row: HTMLElement,
  target: EventTarget | null,
  relatedTarget: EventTarget | null = null,
) {
  const event = new FocusEvent("focusin", { relatedTarget });
  Object.defineProperty(event, "currentTarget", { value: row });
  Object.defineProperty(event, "target", { value: target });
  return event as FocusEvent & { currentTarget: HTMLElement };
}

describe("createRowToolbars", () => {
  it("moves the one shown toolbar with the pointer, however leave events arrive", () => {
    const { rows, shown } = toolbarsWithMenu();
    rows[0]?.onPointerEnter();
    rows[1]?.onPointerEnter();
    expect(shown()).toEqual([2]);

    rows[0]?.onPointerLeave();
    expect(shown()).toEqual([2]);
    rows[1]?.onPointerLeave();
    expect(shown()).toEqual([]);
  });

  it("keeps an open menu's row shown and every hovered row hidden", () => {
    const { rows, shown, setMenuRow } = toolbarsWithMenu();
    setMenuRow(1);
    rows[1]?.onPointerEnter();
    rows[2]?.onPointerEnter();
    expect(shown()).toEqual([1]);

    setMenuRow(undefined);
    expect(shown()).toEqual([3]);
  });

  it("keeps a picker's row shown until its pin is released", () => {
    const { rows, shown } = toolbarsWithMenu();
    const release = rows[0]?.pin();
    rows[2]?.onPointerEnter();
    expect(shown()).toEqual([1]);

    release?.();
    expect(shown()).toEqual([3]);
  });

  it("prefers the keyboard-focused row to the hovered one", () => {
    const { rows, shown } = toolbarsWithMenu();
    rows[0]?.revealForKeyboard();
    rows[1]?.onPointerEnter();
    expect(shown()).toEqual([1]);
  });

  it("ignores focus that reaches a row from a portalled layer", () => {
    const { rows, shown } = toolbarsWithMenu();
    const row = document.createElement("div");
    const search = document.createElement("input");
    document.body.append(row, search);
    search.focus();

    rows[0]?.onFocusIn(focusEvent(row, search));
    expect(shown()).toEqual([]);
  });

  it("forgets a row's hover and focus when it unmounts", () => {
    const { rows, shown } = toolbarsWithMenu();
    rows[0]?.revealForKeyboard();
    rows[0]?.unmount();
    rows[1]?.onPointerEnter();
    rows[1]?.unmount();
    expect(shown()).toEqual([]);
  });
});
