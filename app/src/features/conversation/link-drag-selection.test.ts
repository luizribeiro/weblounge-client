import { afterEach, expect, it, vi } from "vitest";
import { selectFromLinkPress } from "./link-drag-selection";

const href = "https://example.com/docs";

afterEach(() => {
  vi.restoreAllMocks();
});

it("lets a primary mouse press on a link start a WebKit selection, then restores the link", () => {
  vendor("Apple Computer, Inc.");
  const link = messageLink();

  press(link, { pointerType: "mouse", button: 0 });
  expect(link.hasAttribute("href")).toBe(false);

  window.dispatchEvent(new PointerEvent("pointerup"));
  expect(link.getAttribute("href")).toBe(href);
});

it("restores the link when the press is cancelled", () => {
  vendor("Apple Computer, Inc.");
  const link = messageLink();

  press(link, { pointerType: "mouse", button: 0 });
  window.dispatchEvent(new PointerEvent("pointercancel"));

  expect(link.getAttribute("href")).toBe(href);
});

it("restores the link when the window loses focus mid-press", () => {
  vendor("Apple Computer, Inc.");
  const link = messageLink();

  press(link, { pointerType: "mouse", button: 0 });
  window.dispatchEvent(new Event("blur"));

  expect(link.getAttribute("href")).toBe(href);
});

it("restores the link once, so a later press can drop it again", () => {
  vendor("Apple Computer, Inc.");
  const link = messageLink();
  press(link, { pointerType: "mouse", button: 0 });
  window.dispatchEvent(new PointerEvent("pointerup"));

  press(link, { pointerType: "mouse", button: 0 });
  window.dispatchEvent(new PointerEvent("pointercancel"));
  expect(link.getAttribute("href")).toBe(href);

  link.setAttribute("href", "https://example.com/changed");
  window.dispatchEvent(new PointerEvent("pointerup"));
  expect(link.getAttribute("href")).toBe("https://example.com/changed");
});

it("leaves touch, secondary-button and modified presses alone", () => {
  vendor("Apple Computer, Inc.");
  const link = messageLink();

  for (const init of [
    { pointerType: "touch", button: 0 },
    { pointerType: "mouse", button: 2 },
    { pointerType: "mouse", button: 0, metaKey: true },
    { pointerType: "mouse", button: 0, ctrlKey: true },
    { pointerType: "mouse", button: 0, shiftKey: true },
    { pointerType: "mouse", button: 0, altKey: true },
  ])
    press(link, init);

  expect(link.getAttribute("href")).toBe(href);
});

it("leaves Chromium's link presses alone", () => {
  vendor("Google Inc.");
  const link = messageLink();

  press(link, { pointerType: "mouse", button: 0 });

  expect(link.getAttribute("href")).toBe(href);
});

function vendor(value: string): void {
  vi.spyOn(navigator, "vendor", "get").mockReturnValue(value);
}

function messageLink(): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = href;
  link.addEventListener("pointerdown", selectFromLinkPress);
  document.body.append(link);
  return link;
}

function press(link: HTMLAnchorElement, init: PointerEventInit): void {
  link.dispatchEvent(new PointerEvent("pointerdown", init));
}
