import { expect, it, vi } from "vitest";
import { observeMobileViewport } from "./mobile-viewport";

it("tracks the visual viewport until disposed", () => {
  const viewport = new EventTarget() as VisualViewport;
  Object.assign(viewport, { height: 874, offsetTop: 0 });
  const target = { visualViewport: viewport } as Window;
  const onChange = vi.fn();
  const dispose = observeMobileViewport(target, onChange);

  Object.assign(viewport, { height: 516, offsetTop: 42 });
  viewport.dispatchEvent(new Event("resize"));
  Object.assign(viewport, { height: 500 });
  viewport.dispatchEvent(new Event("scroll"));
  dispose();
  viewport.dispatchEvent(new Event("resize"));

  expect(onChange.mock.calls).toEqual([
    [{ height: 874, offsetTop: 0 }],
    [{ height: 516, offsetTop: 42 }],
  ]);
});
