import type { Locator, Page } from "@playwright/test";

export const framesPerSecond = 60;

export function messageRow(page: Page, text: string): Locator {
  return page.locator("[data-message-row]").filter({ hasText: text });
}

export async function timelineOverlapsOverFrames(
  list: Locator,
  frames: number,
): Promise<string[]> {
  return list.evaluate(async (element, frameCount) => {
    const overlaps = new Set<string>();
    const tolerance = 1;
    const sample = () => {
      const rows = [
        ...element.querySelectorAll<HTMLLIElement>("li[data-index]"),
      ]
        .map((row) => ({
          index: Number(row.dataset.index),
          key: row.dataset.rowKey ?? "",
          rect: row.getBoundingClientRect(),
        }))
        .sort((left, right) => left.index - right.index);
      for (const [position, row] of rows.entries()) {
        const next = rows[position + 1];
        if (
          next?.index === row.index + 1 &&
          Math.abs(next.rect.top - row.rect.bottom) > tolerance
        )
          overlaps.add(
            `${row.key} ends at ${row.rect.bottom} but ${next.key} starts at ${next.rect.top}`,
          );
        for (const other of rows.slice(position + 1))
          if (
            Math.min(row.rect.bottom, other.rect.bottom) -
              Math.max(row.rect.top, other.rect.top) >
            tolerance
          )
            overlaps.add(`${row.key} intersects ${other.key}`);
      }
    };
    // wait-ok: overlap is a per-frame property, so it is sampled over a fixed window of frames
    for (let frame = 0; frame < frameCount; frame += 1) {
      sample();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
    sample();
    return [...overlaps];
  }, frames);
}
