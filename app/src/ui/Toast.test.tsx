import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { Toast, type ToastNotice } from "./Toast";

afterEach(() => vi.useRealTimers());

it("dismisses the latest notice after six seconds", async () => {
  vi.useFakeTimers();
  const dismiss = vi.fn();
  const [notice, setNotice] = createSignal<ToastNotice>({
    id: "first",
    message: "First",
  });
  render(() => <Toast notice={notice()} onDismiss={dismiss} />);
  await vi.advanceTimersByTimeAsync(4_000);
  setNotice({ id: "second", message: "Second" });
  await vi.advanceTimersByTimeAsync(5_999);
  expect(dismiss).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(dismiss).toHaveBeenCalledWith("second");
});

it("pauses dismissal while hovered or focused", async () => {
  vi.useFakeTimers();
  const dismiss = vi.fn();
  render(() => (
    <Toast
      notice={{
        id: "failure",
        message: "Not delivered",
        action: { label: "Open", run: () => {} },
      }}
      onDismiss={dismiss}
    />
  ));
  const toast = screen.getByRole("status");
  await vi.advanceTimersByTimeAsync(2_000);
  fireEvent.pointerEnter(toast);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.pointerLeave(toast);
  await vi.advanceTimersByTimeAsync(2_000);
  screen.getByRole("button", { name: "Open" }).focus();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(dismiss).not.toHaveBeenCalled();
  screen.getByRole("button", { name: "Open" }).blur();

  await vi.advanceTimersByTimeAsync(2_000);
  expect(dismiss).toHaveBeenCalledWith("failure");
});

it("runs an action once and dismisses the notice", () => {
  const run = vi.fn();
  const dismiss = vi.fn();
  render(() => (
    <Toast
      notice={{
        id: "failure",
        message: "Not delivered",
        action: { label: "Open", run },
      }}
      onDismiss={dismiss}
    />
  ));

  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(run).toHaveBeenCalledOnce();
  expect(dismiss).toHaveBeenCalledWith("failure");
});
