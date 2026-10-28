import { type CopyRow, serializeCopyRows } from "./copy-rows";

export function copySelectedRows(
  event: ClipboardEvent,
  list: HTMLElement,
  rows: readonly CopyRow[],
): void {
  const selection = list.ownerDocument.getSelection();
  const first = rowIndex(selection?.anchorNode, list);
  const last = rowIndex(selection?.focusNode, list);
  if (
    selection === null ||
    selection.isCollapsed ||
    first === undefined ||
    last === undefined ||
    event.clipboardData === null
  ) {
    return;
  }

  const start = Math.min(first, last);
  const end = Math.max(first, last) + 1;
  const text = serializeCopyRows(rows.slice(start, end));
  if (text === "") return;
  event.clipboardData.setData("text/plain", text);
  event.preventDefault();
}

function rowIndex(
  node: Node | null | undefined,
  list: HTMLElement,
): number | undefined {
  const element = node instanceof Element ? node : node?.parentElement;
  const row = element?.closest<HTMLElement>("[data-copy-row-index]");
  if (row === undefined || row === null || !list.contains(row))
    return undefined;
  const index = Number(row.dataset.copyRowIndex);
  return Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}
