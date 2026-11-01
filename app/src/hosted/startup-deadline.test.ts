import { expect, it, vi } from "vitest";
import { withStartupDeadline } from "./startup-deadline";

it("aborts a hosted startup dependency at its deadline", async () => {
  vi.useFakeTimers();
  const operation = vi.fn(
    (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  const result = withStartupDeadline(
    operation,
    () => new Error("startup dependency timed out"),
    25,
  );
  const rejection = expect(result).rejects.toThrow(
    "startup dependency timed out",
  );

  await vi.advanceTimersByTimeAsync(25);

  await rejection;
  expect(operation.mock.calls[0]?.[0].aborted).toBe(true);
  vi.useRealTimers();
});

it("clears the deadline after the dependency settles", async () => {
  vi.useFakeTimers();

  await expect(
    withStartupDeadline(
      async () => "ready",
      () => new Error("startup dependency timed out"),
      25,
    ),
  ).resolves.toBe("ready");

  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
