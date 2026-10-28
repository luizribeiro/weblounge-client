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
