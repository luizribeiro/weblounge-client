import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { createConnectionProgress } from "./connection-progress";

it("finishes the current shimmer sweep before stopping", () => {
  const [progressing, setProgressing] = createSignal(true);
  const { container } = render(() => {
    const progress = createConnectionProgress(progressing, () => false);
    return (
      <div
        data-progress={progress.active() || undefined}
        onAnimationIteration={progress.finishSweep}
      />
    );
  });
  const indicator = container.firstElementChild;
  if (!(indicator instanceof HTMLElement)) throw new Error("missing indicator");

  setProgressing(false);
  expect(indicator).toHaveAttribute("data-progress");
  fireEvent.animationIteration(indicator);
  expect(indicator).not.toHaveAttribute("data-progress");
});

it("stops immediately when animation is unavailable", () => {
  const [progressing, setProgressing] = createSignal(true);
  const { container } = render(() => {
    const progress = createConnectionProgress(progressing, () => true);
    return <div data-progress={progress.active() || undefined} />;
  });
  const indicator = container.firstElementChild;
  if (!(indicator instanceof HTMLElement)) throw new Error("missing indicator");

  setProgressing(false);
  expect(indicator).not.toHaveAttribute("data-progress");
});
