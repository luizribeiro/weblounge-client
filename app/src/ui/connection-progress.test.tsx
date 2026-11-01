import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { createConnectionProgress } from "./connection-progress";

it("waits for the loading iteration before running the final fill", () => {
  const [progressing, setProgressing] = createSignal(true);
  const { container } = render(() => {
    const progress = createConnectionProgress(progressing, {
      interrupted: () => false,
      prefersReducedMotion: () => false,
      sweepPosition: () => 100,
    });
    return (
      <div
        data-phase={progress.phase()}
        onAnimationEnd={progress.handleAnimationEnd}
        onAnimationIteration={progress.handleAnimationIteration}
      />
    );
  });
  const indicator = container.firstElementChild;
  if (!(indicator instanceof HTMLElement)) throw new Error("missing indicator");

  setProgressing(false);
  expect(indicator).toHaveAttribute("data-phase", "finishing");
  fireEvent.animationIteration(indicator);
  expect(indicator).toHaveAttribute("data-phase", "filling");
  fireEvent.animationEnd(indicator);
  expect(indicator).toHaveAttribute("data-phase", "idle");
});

it("starts the final fill immediately from the loading rest phase", () => {
  const [progressing, setProgressing] = createSignal(true);
  const { container } = render(() => {
    const progress = createConnectionProgress(progressing, {
      interrupted: () => false,
      prefersReducedMotion: () => false,
      sweepPosition: () => 205,
    });
    return <div data-phase={progress.phase()} />;
  });
  const indicator = container.firstElementChild;
  if (!(indicator instanceof HTMLElement)) throw new Error("missing indicator");

  setProgressing(false);
  expect(indicator).toHaveAttribute("data-phase", "filling");
});

it("uses a static loading phase with reduced motion and snaps to idle", () => {
  const [progressing, setProgressing] = createSignal(true);
  const { container } = render(() => {
    const progress = createConnectionProgress(progressing, {
      interrupted: () => false,
      prefersReducedMotion: () => true,
      sweepPosition: () => 100,
    });
    return <div data-phase={progress.phase()} />;
  });
  const indicator = container.firstElementChild;
  if (!(indicator instanceof HTMLElement)) throw new Error("missing indicator");

  expect(indicator).toHaveAttribute("data-phase", "reduced");
  setProgressing(false);
  expect(indicator).toHaveAttribute("data-phase", "idle");
});
