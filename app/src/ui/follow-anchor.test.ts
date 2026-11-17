import { afterEach, describe, expect, it } from "vitest";
import { followAnchor } from "./follow-anchor";

afterEach(() => document.body.replaceChildren());

function box(top: number, bottom: number): DOMRect {
  return DOMRect.fromRect({ x: 0, y: top, width: 100, height: bottom - top });
}

function transcriptWithRow() {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  const row = document.createElement("div");
  scroller.append(row);
  document.body.append(scroller);
  scroller.getBoundingClientRect = () => box(0, 300);
  let rowTop = 100;
  row.getBoundingClientRect = () => box(rowTop, rowTop + 40);
  const scrollTo = (top: number) => {
    rowTop = top;
    scroller.dispatchEvent(new Event("scroll"));
  };
  return { scroller, row, scrollTo };
}

function follow(anchor: Element) {
  const moves: number[] = [];
  let lost = 0;
  const stop = followAnchor(
    anchor,
    (next) => moves.push(next.top),
    () => {
      lost += 1;
    },
  );
  return { moves, lost: () => lost, stop };
}

describe("followAnchor", () => {
  it("reports the anchor's box as its scroller moves it", () => {
    const { row, scrollTo } = transcriptWithRow();
    const followed = follow(row);
    scrollTo(60);
    scrollTo(20);
    expect(followed.moves).toEqual([60, 20]);
    expect(followed.lost()).toBe(0);
  });

  it("loses the anchor once it scrolls out of view, then stops", () => {
    const { row, scrollTo } = transcriptWithRow();
    const followed = follow(row);
    scrollTo(-40);
    scrollTo(10);
    expect(followed.moves).toEqual([]);
    expect(followed.lost()).toBe(1);
  });

  it("loses a detached anchor", () => {
    const { row, scrollTo } = transcriptWithRow();
    const followed = follow(row);
    row.remove();
    scrollTo(100);
    expect(followed.lost()).toBe(1);
  });

  it("ignores scrolling inside layers that cannot move the anchor", () => {
    const { row } = transcriptWithRow();
    const picker = document.createElement("div");
    document.body.append(picker);
    const followed = follow(row);
    picker.dispatchEvent(new Event("scroll"));
    expect(followed.moves).toEqual([]);
  });

  it("stops following when asked", () => {
    const { row, scrollTo } = transcriptWithRow();
    const followed = follow(row);
    followed.stop();
    scrollTo(50);
    expect(followed.moves).toEqual([]);
  });
});
