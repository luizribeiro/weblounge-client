import { type CopyRow, serializeCopyRows } from "./copy-rows";

const rowSelector = "[data-copy-row-index]";

/** Inclusive indexes of the rows a selection copies. */
export interface SelectedRows {
  readonly first: number;
  readonly last: number;
}

export function copySelectedRows(
  event: ClipboardEvent,
  list: HTMLElement,
  rows: readonly (CopyRow | undefined)[],
): void {
  const selected = rowsInSelection(list.ownerDocument.getSelection(), list);
  if (selected === undefined || event.clipboardData === null) return;
  const text =
    selected.oneRow === undefined
      ? serializeCopyRows(
          rows
            .slice(selected.first, selected.last + 1)
            .filter((row): row is CopyRow => row !== undefined),
        )
      : selectableText(selected.range, selected.oneRow);
  if (text === "") return;
  event.clipboardData.setData("text/plain", text);
  event.preventDefault();
}

export function selectedRows(
  selection: Selection | null,
  list: HTMLElement,
): SelectedRows | undefined {
  const selected = rowsInSelection(selection, list);
  return selected === undefined
    ? undefined
    : { first: selected.first, last: selected.last };
}

interface RowsInSelection extends SelectedRows {
  readonly range: Range;
  /** The row's element when the selection copies exactly one row. */
  readonly oneRow: HTMLElement | undefined;
}

interface Endpoint {
  readonly index: number;
  readonly row: HTMLElement | undefined;
}

function rowsInSelection(
  selection: Selection | null,
  list: HTMLElement,
): RowsInSelection | undefined {
  const range = selectionRange(selection);
  if (range === undefined) return undefined;
  const start = endpoint(
    range.startContainer,
    range.startOffset,
    "start",
    list,
  );
  const end = endpoint(range.endContainer, range.endOffset, "end", list);
  if (start === undefined || end === undefined) return undefined;
  const last = onlyTouched(range, end, start) ? stepped(end, -1, start) : end;
  const first = onlyTouched(range, start, last)
    ? stepped(start, 1, last)
    : start;
  if (last.index < first.index) return undefined;
  return {
    first: first.index,
    last: last.index,
    range,
    oneRow: first.index === last.index ? first.row : undefined,
  };
}

/** Firefox splits a selection into several ranges around non-selectable chrome. */
function selectionRange(selection: Selection | null): Range | undefined {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0)
    return undefined;
  const first = selection.getRangeAt(0);
  const last = selection.getRangeAt(selection.rangeCount - 1);
  const range = first.cloneRange();
  range.setEnd(last.endContainer, last.endOffset);
  return range;
}

/**
 * A boundary between children points at the child after it for a range start and the child
 * before it for a range end, which is where WebKit's paragraph selection leaves its end.
 */
function endpoint(
  container: Node,
  offset: number,
  edge: "start" | "end",
  list: HTMLElement,
): Endpoint | undefined {
  const child = container.childNodes[edge === "start" ? offset : offset - 1];
  const node = child ?? container;
  const element = node instanceof Element ? node : node.parentElement;
  const row = element?.closest<HTMLElement>(rowSelector);
  if (row === null || row === undefined || !list.contains(row))
    return undefined;
  const index = Number(row.dataset.copyRowIndex);
  return Number.isSafeInteger(index) && index >= 0 ? { index, row } : undefined;
}

/**
 * An endpoint row the selection reaches without selecting any of its text is not copied. Rows
 * without selectable text (dividers, membership lines) can't hold a visible selection end either.
 */
function onlyTouched(range: Range, row: Endpoint, other: Endpoint): boolean {
  return (
    row.index !== other.index &&
    row.row !== undefined &&
    selectableText(range, row.row) === ""
  );
}

function stepped(row: Endpoint, step: 1 | -1, other: Endpoint): Endpoint {
  const index = row.index + step;
  return { index, row: index === other.index ? other.row : undefined };
}

function selectableText(range: Range, row: HTMLElement): string {
  return Array.from(row.querySelectorAll("[data-selectable]"), (element) =>
    textWithin(range, element),
  ).join("");
}

function textWithin(range: Range, element: Element): string {
  if (!range.intersectsNode(element)) return "";
  const clamped = element.ownerDocument.createRange();
  clamped.selectNodeContents(element);
  if (range.compareBoundaryPoints(Range.START_TO_START, clamped) > 0)
    clamped.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, clamped) < 0)
    clamped.setEnd(range.endContainer, range.endOffset);
  return clamped.toString();
}
