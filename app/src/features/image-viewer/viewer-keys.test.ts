import { expect, it } from "vitest";
import { viewerCommand } from "./viewer-keys";

const key = (value: string, modifiers: Partial<KeyboardEvent> = {}) =>
  viewerCommand({
    altKey: false,
    ctrlKey: false,
    key: value,
    metaKey: false,
    ...modifiers,
  });

it("closes on Escape", () => {
  expect(key("Escape")).toEqual({ kind: "close" });
});

it("zooms with the produced plus and minus characters, shifted or not", () => {
  expect(key("+")).toEqual({ kind: "zoom", direction: "in" });
  expect(key("=")).toEqual({ kind: "zoom", direction: "in" });
  expect(key("-")).toEqual({ kind: "zoom", direction: "out" });
  expect(key("_")).toEqual({ kind: "zoom", direction: "out" });
});

it("resets to fit on 0", () => {
  expect(key("0")).toEqual({ kind: "reset" });
});

it("pans the image opposite to the arrow so the view moves that way", () => {
  expect(key("ArrowRight")).toEqual({ kind: "pan", x: -80, y: 0 });
  expect(key("ArrowUp")).toEqual({ kind: "pan", x: 0, y: 80 });
});

it("leaves modified chords, such as browser zoom, and other keys alone", () => {
  expect(key("+", { metaKey: true })).toBeUndefined();
  expect(key("0", { ctrlKey: true })).toBeUndefined();
  expect(key("Escape", { altKey: true })).toBeUndefined();
  expect(key("a")).toBeUndefined();
  expect(key("toString")).toBeUndefined();
});
