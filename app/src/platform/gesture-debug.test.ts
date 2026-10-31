import { afterEach, expect, it } from "vitest";
import {
  beginGestureDebug,
  clearGestureDiagnostics,
  installGestureDebug,
  readGestureDiagnostics,
  recordGestureNotStarted,
} from "./gesture-debug";

afterEach(() => {
  clearGestureDiagnostics();
  document.body.replaceChildren();
});

it("keeps the last five gesture decisions with keyboard state", () => {
  const root = document.createElement("div");
  root.dataset.keyboard = "open";
  for (let index = 0; index < 6; index += 1) {
    recordGestureNotStarted(
      "swipe-back",
      pointer(index, index + 10, 100),
      `reason-${index}`,
    );
  }

  const readings = readGestureDiagnostics(root);

  expect(readings).toHaveLength(6);
  expect(readings[0]).toEqual(["data-keyboard", "open"]);
  expect(readings[1]?.[1]).toContain("5,15 swipe-back");
  expect(readings[1]?.[1]).toContain("not-started:reason-5");
  expect(readings.at(-1)?.[1]).toContain("not-started:reason-1");
});

it("renders lock and release details in the shared overlay", () => {
  const root = document.createElement("div");
  root.dataset.keyboard = "closed";
  document.body.append(root);
  const stop = installGestureDebug(root, window);
  const trace = beginGestureDebug("member-close", pointer(100, 200, 1_000));
  trace.claim(12, 2, 1_010);
  trace.up(false, {
    averageVelocity: 0.1,
    distance: 40,
    releaseVelocity: -0.3,
  });

  const overlay = document.querySelector("[data-debug-overlay]");
  expect(overlay?.textContent).toContain("[gestures]");
  expect(overlay?.textContent).toContain("horizontal@12,2");
  expect(overlay?.textContent).toContain("up-cancel d=40 avg=0.1 release=-0.3");

  stop();
  expect(document.querySelector("[data-debug-overlay]")).toBeNull();
});

function pointer(clientX: number, clientY: number, timeStamp: number) {
  return { clientX, clientY, timeStamp } as PointerEvent;
}
