import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ForegroundLease } from "./foreground-lease";

const device = { id: "device-1", secret: "device-secret" };
const accepted = Promise.resolve({ ok: true as const, value: null });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("renews only while foreground and releases immediately on hide", async () => {
  const renew = vi.fn(() => accepted);
  const release = vi.fn(() => accepted);
  const lease = new ForegroundLease({
    renew,
    release,
    tabId: "tab-1",
  });

  lease.setDevice(device);
  lease.setForeground(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(renew).toHaveBeenCalledTimes(2);

  lease.setForeground(false);
  expect(release).toHaveBeenCalledWith(device, "tab-1");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(renew).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not leave a heartbeat after an in-flight renewal is hidden", async () => {
  let finishRenewal = () => {};
  const renewing = new Promise<
    Awaited<ReturnType<ForegroundLeaseOptions["renew"]>>
  >((resolve) => {
    finishRenewal = () => resolve({ ok: true, value: null });
  });
  const renew = vi.fn(() => renewing);
  const release = vi.fn(() => accepted);
  const lease = new ForegroundLease({
    renew,
    release,
    tabId: "tab-1",
  });
  lease.setDevice(device);
  lease.setForeground(true);

  lease.setForeground(false);
  finishRenewal();
  await renewing;

  expect(release).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

type ForegroundLeaseOptions = ConstructorParameters<typeof ForegroundLease>[0];
