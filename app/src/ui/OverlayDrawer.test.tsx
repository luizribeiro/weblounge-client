import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { OverlayDrawer } from "./OverlayDrawer";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
});

function renderDrawer() {
  const close = vi.fn();
  const view = render(() => (
    <OverlayDrawer
      closeLabel="Close channels"
      edge="left"
      label="Channels"
      onClose={close}
      width="256px"
    >
      <button type="button">First</button>
      <button type="button">Last</button>
    </OverlayDrawer>
  ));
  return {
    close,
    dialog: screen.getByRole("dialog", { name: "Channels" }),
    overlay: view.container.querySelector('[data-overlay-drawer="left"]'),
  };
}

function transitionEnd(propertyName: string): Event {
  return Object.assign(new Event("transitionend", { bubbles: true }), {
    propertyName,
  });
}

function runningAnimations(animations: readonly Partial<CSSTransition>[]) {
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => animations,
  });
}

const transformTransition = {
  playState: "running",
  transitionProperty: "transform",
} as const;

it("traps focus and closes a mirrored drawer with Escape", async () => {
  const { close, dialog, overlay } = renderDrawer();
  const first = screen.getByRole("button", { name: "First" });
  const last = screen.getByRole("button", { name: "Last" });
  await Promise.resolve();
  expect(first).toHaveFocus();

  last.focus();
  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(overlay).toHaveAttribute("data-phase", "closing");
  expect(close).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
});

it("paints the start state for two frames before opening", () => {
  const frames = holdFrames();
  runningAnimations([transformTransition]);
  const { dialog, overlay } = renderDrawer();
  expect(overlay).toHaveAttribute("data-phase", "entering");
  expect(overlay).toHaveAttribute("data-moving", "true");

  frames.shift()?.(0);
  expect(overlay).toHaveAttribute("data-phase", "entering");
  frames.shift()?.(16);
  expect(overlay).toHaveAttribute("data-phase", "opening");

  fireEvent(dialog, transitionEnd("opacity"));
  expect(overlay).toHaveAttribute("data-phase", "opening");
  runningAnimations([]);
  fireEvent(dialog, transitionEnd("transform"));
  expect(overlay).toHaveAttribute("data-phase", "open");
  expect(overlay).not.toHaveAttribute("data-moving");
});

it("unmounts only when the closing transform transition ends", async () => {
  runningAnimations([transformTransition]);
  const { close, dialog, overlay } = renderDrawer();

  fireEvent.click(screen.getByRole("button", { name: "Close channels" }));
  expect(overlay).toHaveAttribute("data-phase", "closing");
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();

  runningAnimations([]);
  fireEvent(dialog, transitionEnd("transform"));
  expect(close).toHaveBeenCalledOnce();
});

function holdFrames(): FrameRequestCallback[] {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  return frames;
}

it("ignores the opening transition's end once closing has begun", async () => {
  const frames = holdFrames();
  const animations: Partial<CSSTransition>[] = [transformTransition];
  runningAnimations(animations);
  const { close, dialog, overlay } = renderDrawer();
  frames.shift()?.(0);
  frames.shift()?.(16);
  expect(overlay).toHaveAttribute("data-phase", "opening");

  fireEvent.click(screen.getByRole("button", { name: "Close channels" }));
  fireEvent(dialog, transitionEnd("transform"));
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();

  animations.length = 0;
  fireEvent(dialog, transitionEnd("transform"));
  expect(close).toHaveBeenCalledOnce();
});

it("tells its content when it has settled open", () => {
  const frames = holdFrames();
  runningAnimations([transformTransition]);
  let settledOpen = () => true;
  render(() => (
    <OverlayDrawer
      closeLabel="Close members"
      edge="right"
      label="Members"
      onClose={() => {}}
      width="300px"
    >
      {(_close, open) => {
        settledOpen = open;
        return <button type="button">Close</button>;
      }}
    </OverlayDrawer>
  ));
  expect(settledOpen()).toBe(false);
  frames.shift()?.(0);
  frames.shift()?.(16);
  expect(settledOpen()).toBe(false);
  fireEvent(
    screen.getByRole("dialog", { name: "Members" }),
    transitionEnd("transform"),
  );
  expect(settledOpen()).toBe(false);
  runningAnimations([]);
  fireEvent(
    screen.getByRole("dialog", { name: "Members" }),
    transitionEnd("transform"),
  );
  expect(settledOpen()).toBe(true);
});

it("finishes a drag return that has nothing left to animate", async () => {
  runningAnimations([]);
  const [returning, setReturning] = createSignal<boolean>();
  const returned = vi.fn();
  render(() => (
    <OverlayDrawer
      closeLabel="Close members"
      dragProgress={0}
      dragReturning={returning()}
      edge="right"
      label="Members"
      onClose={() => {}}
      onDragReturnEnd={returned}
      width="300px"
    >
      <button type="button">Close</button>
    </OverlayDrawer>
  ));
  setReturning(true);
  await Promise.resolve();
  expect(returned).toHaveBeenCalledOnce();
});

it("closes at once when no transform transition runs", async () => {
  runningAnimations([{ playState: "running", transitionProperty: "opacity" }]);
  const { close } = renderDrawer();

  fireEvent.click(screen.getByRole("button", { name: "Close channels" }));
  expect(close).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
});

it("focuses its marked field without scrolling the shell behind it", async () => {
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  render(() => (
    <OverlayDrawer
      closeLabel="Close members"
      edge="right"
      label="Members"
      onClose={() => {}}
      width="300px"
    >
      <button type="button">Close</button>
      <input aria-label="Filter" data-initial-focus="true" />
    </OverlayDrawer>
  ));
  await Promise.resolve();

  expect(screen.getByRole("textbox", { name: "Filter" })).toHaveFocus();
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});
