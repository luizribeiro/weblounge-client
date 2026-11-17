import { createSignal, onCleanup } from "solid-js";
import { type SelectedRows, selectedRows } from "./copy-selection";

/**
 * Tracks which rows a selection spanning two or more rows would copy as log lines, so their
 * non-selectable time and nick can be painted as selected.
 */
export function createCopiedRows(): {
  readonly track: (list: HTMLElement) => void;
  readonly includes: (index: number) => boolean;
} {
  const [rows, setRows] = createSignal<SelectedRows | undefined>(undefined, {
    equals: sameRows,
  });
  let stop = () => {};
  onCleanup(() => stop());
  return {
    track: (list) => {
      stop();
      const update = () => {
        const selected = selectedRows(document.getSelection(), list);
        setRows(spansRows(selected) ? selected : undefined);
      };
      // A ref runs while the element still belongs to Solid's template document, so its
      // ownerDocument never sees the page's selection changes.
      document.addEventListener("selectionchange", update);
      stop = () => document.removeEventListener("selectionchange", update);
    },
    includes: (index) => {
      const current = rows();
      return (
        current !== undefined && index >= current.first && index <= current.last
      );
    },
  };
}

function spansRows(
  selected: SelectedRows | undefined,
): selected is SelectedRows {
  return selected !== undefined && selected.last > selected.first;
}

function sameRows(
  previous: SelectedRows | undefined,
  next: SelectedRows | undefined,
): boolean {
  return previous?.first === next?.first && previous?.last === next?.last;
}
