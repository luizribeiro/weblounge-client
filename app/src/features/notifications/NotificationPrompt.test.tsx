import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { NotificationPrompt } from "./NotificationPrompt";

it("turns notifications on and can be dismissed", () => {
  const turnOn = vi.fn();
  const dismiss = vi.fn();
  render(() => <NotificationPrompt onDismiss={dismiss} onTurnOn={turnOn} />);

  expect(screen.getByText("Get notified about DMs and mentions")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss notification prompt" }),
  );

  expect(turnOn).toHaveBeenCalledOnce();
  expect(dismiss).toHaveBeenCalledOnce();
});
