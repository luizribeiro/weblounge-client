import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createNotifier, type ToastNotice } from "./notices";
import { Toast } from "./Toast";

afterEach(() => vi.useRealTimers());

it("dismisses the latest notice after six seconds", async () => {
  vi.useFakeTimers();
  const dismiss = vi.fn();
  const [notice, setNotice] = createSignal<ToastNotice>({
    id: "first",
    message: { key: "engine.connection_failed" },
    tone: "error",
  });
  render(() => (
    <Toast notice={notice()} onAction={vi.fn()} onDismiss={dismiss} />
  ));
  await vi.advanceTimersByTimeAsync(4_000);
  setNotice({
    id: "second",
    message: { key: "engine.state_inconsistent" },
    tone: "neutral",
  });
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
        message: {
          key: "notice.message_not_delivered",
          values: { target: "ana" },
        },
        tone: "error",
        action: { label: "action.open", run: "buffer.open" },
      }}
      onAction={vi.fn()}
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

it("dispatches an action id once and dismisses the notice", () => {
  const onAction = vi.fn();
  const dismiss = vi.fn();
  render(() => (
    <Toast
      notice={{
        id: "failure",
        message: {
          key: "notice.message_not_delivered",
          values: { target: "ana" },
        },
        tone: "error",
        action: { label: "action.open", run: "buffer.open" },
      }}
      onAction={onAction}
      onDismiss={dismiss}
    />
  ));

  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(onAction).toHaveBeenCalledOnce();
  expect(onAction).toHaveBeenCalledWith("buffer.open");
  expect(dismiss).toHaveBeenCalledWith("failure");
});

it("replaces the visible notice through the typed notifier", () => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "notice-id") });
  const notifier = createNotifier();
  notifier.notify({
    message: { key: "engine.connection_failed" },
    tone: "error",
  });

  expect(notifier.notice()).toEqual({
    id: "notice-id",
    message: { key: "engine.connection_failed" },
    tone: "error",
  });
  notifier.dismiss("notice-id");
  expect(notifier.notice()).toBeUndefined();
  vi.unstubAllGlobals();
});
