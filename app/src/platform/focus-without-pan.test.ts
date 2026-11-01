import { expect, it, vi } from "vitest";
import { focusWithoutViewportPan, TouchTapGesture } from "./focus-without-pan";
import { keyboardGeometryMeasuredEvent } from "./viewport-geometry";

it("focuses above the viewport until measured keyboard geometry arrives", () => {
  const field = document.createElement("textarea");
  field.style.transform = "scale(1)";
  document.body.append(field);
  const focus = vi.spyOn(field, "focus");

  expect(focusWithoutViewportPan(field, window)).toBe(true);

  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(field.style.transform).toBe("translateY(-2000px)");
  window.dispatchEvent(new Event(keyboardGeometryMeasuredEvent));
  expect(field.style.transform).toBe("scale(1)");
});

it("restores the field immediately when WebKit refuses focus", () => {
  const field = document.createElement("textarea");
  field.style.transform = "scale(1)";
  vi.spyOn(field, "focus").mockImplementation(() => {});

  expect(focusWithoutViewportPan(field, window)).toBe(false);

  expect(document.activeElement).not.toBe(field);
  expect(field.style.transform).toBe("scale(1)");
});

it("recognizes a short touch within tap slop", () => {
  const gesture = new TouchTapGesture();
  gesture.begin(touch(20, 40), 100);
  gesture.move(touch(26, 46));

  expect(gesture.end(touch(27, 46), 180)).toEqual({ accepted: true });
});

it("retains prototype-backed browser touch properties", () => {
  const gesture = new TouchTapGesture();
  gesture.begin(browserTouch(20, 40, 81), 100);

  expect(gesture.end(browserTouch(20, 40, 81), 181)).toEqual({
    accepted: true,
  });
});

it("recognizes a 63ms tap with small diagonal movement", () => {
  const gesture = new TouchTapGesture();
  gesture.begin(touch(20, 40), 100);
  gesture.move(touch(30, 50));

  expect(gesture.end(touch(30, 50), 163)).toEqual({ accepted: true });
});

it("rejects a drag even if it returns near its start", () => {
  const gesture = new TouchTapGesture();
  gesture.begin(touch(20, 40), 100);
  gesture.move(touch(40, 40));

  expect(gesture.end(touch(22, 40), 180)).toEqual({
    accepted: false,
    reason: "moved 20px",
  });
});

it("rejects a long-press without consuming its native behavior", () => {
  const gesture = new TouchTapGesture();
  gesture.begin(touch(20, 40), 100);

  expect(gesture.end(touch(20, 40), 600)).toEqual({
    accepted: false,
    reason: "held 500ms",
  });
});

it("identifies both touches when the tracked finger changes", () => {
  const gesture = new TouchTapGesture();
  gesture.begin(touch(20, 40, 7), 100);

  expect(gesture.end(touch(20, 40, 9), 180)).toEqual({
    accepted: false,
    reason: "touch changed from 7 to 9",
  });
});

function touch(clientX: number, clientY: number, identifier = 7) {
  return { clientX, clientY, identifier };
}

function browserTouch(clientX: number, clientY: number, identifier: number) {
  return Object.create(
    Object.defineProperties(
      {},
      {
        clientX: { get: () => clientX },
        clientY: { get: () => clientY },
        identifier: { get: () => identifier },
      },
    ),
  ) as {
    readonly clientX: number;
    readonly clientY: number;
    readonly identifier: number;
  };
}
