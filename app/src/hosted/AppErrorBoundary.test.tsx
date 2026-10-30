import { render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { AppErrorBoundary, renderFailureMessage } from "./AppErrorBoundary";

afterEach(() => {
  vi.restoreAllMocks();
});

it("replaces a frozen app with a retryable failure when an update throws", () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const failure = new Error("render failed");
  const [broken, setBroken] = createSignal(false);
  const Conversation = () => (
    <p>
      {(() => {
        if (broken()) throw failure;
        return "#lounge";
      })()}
    </p>
  );
  render(() => (
    <AppErrorBoundary>
      <Conversation />
    </AppErrorBoundary>
  ));
  expect(screen.getByText("#lounge")).toBeVisible();

  setBroken(true);

  expect(screen.getByRole("alert")).toHaveTextContent(renderFailureMessage);
  expect(screen.queryByText("#lounge")).toBeNull();
  expect(logged).toHaveBeenCalledWith(failure);

  setBroken(false);
  screen.getByRole("button", { name: "Retry" }).click();
  expect(screen.getByText("#lounge")).toBeVisible();
});
