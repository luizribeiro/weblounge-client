export interface VisibleMessageAnchor {
  readonly offset: number;
  readonly text: string;
}

export function visibleMessageAnchor(list: HTMLElement): VisibleMessageAnchor {
  const listRect = list.getBoundingClientRect();
  const row = [
    ...list.querySelectorAll<HTMLElement>("[data-message-row]"),
  ].find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return rect.top >= listRect.top && rect.bottom <= listRect.bottom;
  });
  if (row === undefined) throw new Error("visible message anchor missing");
  return {
    offset: row.getBoundingClientRect().top - listRect.top,
    text: row.dataset.messageText ?? "",
  };
}
