import { render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { createForegroundSignal } from "./foreground";

const standaloneDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "standalone",
);

afterEach(() => {
  vi.restoreAllMocks();
  if (standaloneDescriptor === undefined)
    Reflect.deleteProperty(navigator, "standalone");
  else Object.defineProperty(navigator, "standalone", standaloneDescriptor);
});

it("treats a visible iOS standalone page as foreground", () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  Object.defineProperty(navigator, "standalone", {
    configurable: true,
    value: true,
  });
  let foreground = false;

  render(() => {
    foreground = createForegroundSignal()();
    return undefined;
  });

  expect(foreground).toBe(true);
});

it("publishes hidden and background transitions from one signal", () => {
  let hidden = false;
  let focused = true;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  let readForeground = () => false;

  render(() => {
    readForeground = createForegroundSignal();
    return undefined;
  });

  expect(readForeground()).toBe(true);
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(readForeground()).toBe(false);
  hidden = false;
  focused = false;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(readForeground()).toBe(false);
  focused = true;
  window.dispatchEvent(new Event("focus"));
  expect(readForeground()).toBe(true);
});
