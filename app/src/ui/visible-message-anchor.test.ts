import { expect, it } from "vitest";
import { visibleMessageAnchor } from "../../e2e/visible-message-anchor";

it("skips a message whose text row is clipped by the transcript", () => {
  const list = document.createElement("div");
  const clipped = messageRow("clipped", 2, 48);
  const visible = messageRow("visible", 50, 48);
  list.append(clipped, visible);
  list.getBoundingClientRect = () => rect(48, 609);

  expect(visibleMessageAnchor(list)).toEqual({ offset: 2, text: "visible" });
});

function messageRow(text: string, top: number, height: number): HTMLElement {
  const row = document.createElement("div");
  row.dataset.messageRow = "true";
  row.dataset.messageText = text;
  row.getBoundingClientRect = () => rect(top, height);
  return row;
}

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    top,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}
