import { createRoot } from "solid-js";
import { expect, it } from "vitest";
import { createCopiedRows } from "./copied-rows";

it("includes every row of a selection that spans rows", () => {
  const list = transcript(["first line", "middle line", "last line"]);
  createRoot((dispose) => {
    const copied = createCopiedRows();
    copied.track(list);

    select(rowText(list, 0), 3, rowText(list, 2), 4);
    document.dispatchEvent(new Event("selectionchange"));

    expect([0, 1, 2, 3].map(copied.includes)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    dispose();
  });
});

it("includes no row while the selection stays inside one row", () => {
  const list = transcript(["first line", "second line"]);
  createRoot((dispose) => {
    const copied = createCopiedRows();
    copied.track(list);

    select(rowText(list, 0), 0, rowText(list, 1), 0);
    document.dispatchEvent(new Event("selectionchange"));

    expect([0, 1].map(copied.includes)).toEqual([false, false]);
    dispose();
  });
});

it("clears the rows once the selection collapses", () => {
  const list = transcript(["first line", "second line"]);
  createRoot((dispose) => {
    const copied = createCopiedRows();
    copied.track(list);
    select(rowText(list, 0), 3, rowText(list, 1), 4);
    document.dispatchEvent(new Event("selectionchange"));

    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));

    expect([0, 1].map(copied.includes)).toEqual([false, false]);
    dispose();
  });
});

it("stops following the selection once disposed", () => {
  const list = transcript(["first line", "second line"]);
  const copied = createRoot((dispose) => {
    const rows = createCopiedRows();
    rows.track(list);
    dispose();
    return rows;
  });

  select(rowText(list, 0), 0, rowText(list, 1), 3);
  document.dispatchEvent(new Event("selectionchange"));

  expect(copied.includes(0)).toBe(false);
});

function transcript(lines: readonly string[]): HTMLOListElement {
  const list = document.createElement("ol");
  for (const [index, line] of lines.entries()) {
    const row = document.createElement("li");
    row.dataset.copyRowIndex = index.toString();
    const text = document.createElement("span");
    text.dataset.selectable = "true";
    text.textContent = line;
    row.append(text);
    list.append(row);
  }
  document.body.append(list);
  return list;
}

function rowText(list: HTMLElement, index: number): Text {
  const text = list.children[index]?.firstChild?.firstChild;
  if (!(text instanceof Text)) throw new Error("row text is unavailable");
  return text;
}

function select(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
): void {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = document.getSelection();
  if (selection === null) throw new Error("selection fixture is unavailable");
  selection.removeAllRanges();
  selection.addRange(range);
}
