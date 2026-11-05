import { afterEach, describe, expect, it, vi } from "vitest";
import { PushFallbackCoordinator } from "./push-fallback-coordinator";

describe("push fallback coordination", () => {
  afterEach(() => vi.useRealTimers());

  it("retains a presented fallback until notification enumeration catches up", async () => {
    vi.useFakeTimers();
    const fallback = { id: "receipt" };
    let notifications: readonly (typeof fallback)[] = [];
    const coordinator = new PushFallbackCoordinator(
      async () => notifications,
      (notification, id) => notification.id === id,
      () => new Promise((resolve) => setTimeout(resolve, 20)),
    );

    coordinator.track("receipt");
    const taken = coordinator.take("receipt");
    await vi.advanceTimersByTimeAsync(2_000);
    notifications = [fallback];
    await vi.advanceTimersByTimeAsync(20);

    await expect(taken).resolves.toEqual([fallback]);
  });
});
