import { expect, it, vi } from "vitest";
import type { CopyRow } from "./copy-rows";
import { copySelectedRows } from "./copy-selection";

it("copies the selected row range from data instead of DOM text", () => {
  const list = messageList();
  const selection = document.getSelection();
  const range = document.createRange();
  const firstText = list.children[0]?.firstChild;
  const secondText = list.children[1]?.firstChild;
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
  const first = list.children[0]?.firstChild;
  const last = list.children[1]?.firstChild;
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
    "DOM decoration two",
  ].entries()) {
    const row = document.createElement("li");
    row.dataset.copyRowIndex = index.toString();
    row.textContent = text;
    list.append(row);
  }
  document.body.append(list);
  return list;
}
