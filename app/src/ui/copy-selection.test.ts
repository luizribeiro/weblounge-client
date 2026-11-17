import { expect, it, vi } from "vitest";
import type { CopyRow } from "./copy-rows";
import { copySelectedRows, selectedRows } from "./copy-selection";

it("copies the selected row range from data instead of DOM text", () => {
  const list = messageList();
  const selection = document.getSelection();
  const range = document.createRange();
  const firstText = list.children[0]?.lastChild?.firstChild;
  const secondText = list.children[1]?.lastChild?.firstChild;
  if (
    selection === null ||
    firstText === undefined ||
    firstText === null ||
    secondText === undefined ||
    secondText === null
  ) {
    throw new Error("selection fixture is unavailable");
  }
  range.setStart(firstText, 0);
  range.setEnd(secondText, secondText.textContent?.length ?? 0);
  selection.removeAllRanges();
  selection.addRange(range);
  const setData = vi.fn();
  const preventDefault = vi.fn();

  copySelectedRows(
    { clipboardData: { setData }, preventDefault } as unknown as ClipboardEvent,
    list,
    copyRows,
  );

  expect(setData).toHaveBeenCalledWith(
    "text/plain",
    "[22:01] <luiz> first\n[22:02] <tomo> second",
  );
  expect(preventDefault).toHaveBeenCalledOnce();
});

it("leaves selections outside the message list to native copy", () => {
  const list = messageList();
  const outside = document.createTextNode("outside");
  document.body.append(outside);
  const selection = document.getSelection();
  const range = document.createRange();
  if (selection === null) throw new Error("selection fixture is unavailable");
  range.selectNodeContents(outside);
  selection.removeAllRanges();
  selection.addRange(range);
  const preventDefault = vi.fn();

  copySelectedRows(
    {
      clipboardData: { setData: vi.fn() },
      preventDefault,
    } as unknown as ClipboardEvent,
    list,
    copyRows,
  );

  expect(preventDefault).not.toHaveBeenCalled();
});

it("copies data rows virtualised out between the selection endpoints", () => {
  const list = messageList();
  list.children[1]?.setAttribute("data-copy-row-index", "4");
  const selection = document.getSelection();
  const range = document.createRange();
  const first = list.children[0]?.lastChild?.firstChild;
  const last = list.children[1]?.lastChild?.firstChild;
  if (
    selection === null ||
    first === undefined ||
    first === null ||
    last === undefined ||
    last === null
  ) {
    throw new Error("selection fixture is unavailable");
  }
  range.setStart(first, 0);
  range.setEnd(last, last.textContent?.length ?? 0);
  selection.removeAllRanges();
  selection.addRange(range);
  const setData = vi.fn();

  copySelectedRows(
    {
      clipboardData: { setData },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent,
    list,
    [
      copyRows[0],
      ...["hidden one", "hidden two", "hidden three"].map((text) => ({
        ...copyRows[0],
        text,
      })),
      copyRows[1],
    ].filter((row): row is CopyRow => row !== undefined),
  );

  expect(setData).toHaveBeenCalledWith(
    "text/plain",
    [
      "[22:01] <luiz> first",
      "[22:01] <luiz> hidden one",
      "[22:01] <luiz> hidden two",
      "[22:01] <luiz> hidden three",
      "[22:02] <tomo> second",
    ].join("\n"),
  );
});

it("keeps selection indices aligned across a non-copying divider", () => {
  const list = messageList();
  list.children[1]?.setAttribute("data-copy-row-index", "2");
  const selection = document.getSelection();
  const range = document.createRange();
  const first = list.children[0]?.lastChild?.firstChild;
  const last = list.children[1]?.lastChild?.firstChild;
  if (
    selection === null ||
    first === undefined ||
    first === null ||
    last === undefined ||
    last === null
  ) {
    throw new Error("selection fixture is unavailable");
  }
  range.setStart(first, 0);
  range.setEnd(last, last.textContent?.length ?? 0);
  selection.removeAllRanges();
  selection.addRange(range);
  const setData = vi.fn();

  copySelectedRows(
    {
      clipboardData: { setData },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent,
    list,
    [copyRows[0], undefined, copyRows[1]],
  );

  expect(setData).toHaveBeenCalledWith(
    "text/plain",
    "[22:01] <luiz> first\n[22:02] <tomo> second",
  );
});

it("copies only the selected text of one row, keeping its newlines", () => {
  const list = messageList();
  const text = rowText(list, 1);
  select(text, 4, text, 18);

  expect(copied(list)).toBe("decoration\ntwo");
});

it("does not copy a next row that a selection only reaches at its start", () => {
  const list = messageList();
  const first = rowText(list, 0);
  select(first, 0, list.children[1] ?? list, 0);

  expect(copied(list)).toBe("DOM decoration one");
  expect(selectedRows(document.getSelection(), list)).toEqual({
    first: 0,
    last: 0,
  });
});

it("resolves an end between rows to the row before it", () => {
  const list = messageList();
  select(rowText(list, 0), 4, list, 1);

  expect(copied(list)).toBe("decoration one");
});

it("reports both rows of a selection that spans them", () => {
  const list = messageList();
  select(rowText(list, 0), 4, rowText(list, 1), 3);

  expect(selectedRows(document.getSelection(), list)).toEqual({
    first: 0,
    last: 1,
  });
});

it("does not copy a first row that a selection only reaches at its end", () => {
  const list = messageList();
  const first = rowText(list, 0);
  select(first, first.length, rowText(list, 1), 3);

  expect(copied(list)).toBe("DOM");
});

it("clamps a one-row selection to the row's selectable text", () => {
  const list = messageList();
  const time = list.children[0]?.firstChild?.firstChild;
  if (!(time instanceof Text)) throw new Error("row time is unavailable");
  select(time, 1, rowText(list, 0), 5);

  expect(copied(list)).toBe("DOM d");
});

it("copies a backwards selection across rows the same way", () => {
  const list = messageList();
  const selection = document.getSelection();
  if (selection === null) throw new Error("selection fixture is unavailable");
  selection.setBaseAndExtent(rowText(list, 1), 3, rowText(list, 0), 4);

  expect(copied(list)).toBe("[22:01] <luiz> first\n[22:02] <tomo> second");
});

it("joins the ranges Firefox splits a selection into", () => {
  const list = messageList();
  const head = document.createRange();
  head.setStart(rowText(list, 0), 4);
  head.setEnd(rowText(list, 0), 8);
  const tail = document.createRange();
  tail.setStart(rowText(list, 1), 0);
  tail.setEnd(rowText(list, 1), 3);
  const split = {
    isCollapsed: false,
    rangeCount: 2,
    getRangeAt: (index: number) => (index === 0 ? head : tail),
  } as unknown as Selection;

  expect(selectedRows(split, list)).toEqual({ first: 0, last: 1 });
});

it("leaves a collapsed selection to native copy", () => {
  const list = messageList();
  select(rowText(list, 0), 2, rowText(list, 0), 2);

  expect(copied(list)).toBeUndefined();
});

function rowText(list: HTMLElement, index: number): Text {
  const text = list.children[index]?.lastChild?.firstChild;
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

function copied(list: HTMLElement): string | undefined {
  const setData = vi.fn();
  copySelectedRows(
    {
      clipboardData: { setData },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent,
    list,
    copyRows,
  );
  return setData.mock.calls[0]?.[1];
}

const copyRows: readonly CopyRow[] = [
  {
    kind: "message",
    time: new Date(2026, 9, 27, 22, 1),
    author: "luiz",
    text: "first",
  },
  {
    kind: "message",
    time: new Date(2026, 9, 27, 22, 2),
    author: "tomo",
    text: "second",
  },
];

function messageList(): HTMLOListElement {
  const list = document.createElement("ol");
  for (const [index, text] of [
    "DOM decoration one",
    "DOM decoration\ntwo",
  ].entries()) {
    const row = document.createElement("li");
    row.dataset.copyRowIndex = index.toString();
    const time = document.createElement("time");
    time.textContent = "22:0";
    const selectable = document.createElement("span");
    selectable.dataset.selectable = "true";
    selectable.textContent = text;
    row.append(time, selectable);
    list.append(row);
  }
  document.body.append(list);
  return list;
}
