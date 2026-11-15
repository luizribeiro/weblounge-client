import { expect, it } from "vitest";
import { pickerPosition } from "./picker-position";

const picker = { width: 312, height: 330 };
const viewport = { innerWidth: 1280, innerHeight: 800 };

it("opens below the toolbar button, aligned to its right edge", () => {
  expect(
    pickerPosition({ top: 100, bottom: 128, right: 1200 }, picker, viewport),
  ).toEqual({ left: 888, top: 134 });
});

it("flips above a button near the bottom of the window", () => {
  expect(
    pickerPosition({ top: 700, bottom: 728, right: 1200 }, picker, viewport),
  ).toEqual({ left: 888, top: 364 });
});

it("stays inside a window too small for either side", () => {
  expect(
    pickerPosition({ top: 200, bottom: 228, right: 200 }, picker, {
      innerWidth: 400,
      innerHeight: 400,
    }),
  ).toEqual({ left: 8, top: 62 });
});
