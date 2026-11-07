import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ForegroundLease } from "./foreground-lease";

const device = { id: "device-1", secret: "device-secret" };
const accepted = Promise.resolve({ ok: true as const, value: null });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("renews only while its owner is active without releasing on handoff", async () => {
  const renew = vi.fn(() => accepted);
  const release = vi.fn(() => accepted);
  const onAction = vi.fn();
  const lease = new ForegroundLease({ renew, release, onAction });

  lease.setDevice(device);
  lease.setActive(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(renew).toHaveBeenCalledTimes(2);
  expect(renew).toHaveBeenCalledWith(device, "device");
  expect(onAction.mock.calls).toEqual([
    ["acquire", "sent"],
    ["acquire", "ok"],
    ["renew", "sent"],
    ["renew", "ok"],
  ]);

  lease.setActive(false);
  expect(release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(renew).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("shares one renewal cadence across owners", async () => {
  const storage = new MemoryStorage();
  const renew = vi.fn(() => accepted);
  const release = vi.fn(() => accepted);
  const first = new ForegroundLease({ renew, release, storage });
  const second = new ForegroundLease({ renew, release, storage });
  first.setDevice(device);
  second.setDevice(device);

  first.setActive(true);
  await vi.advanceTimersByTimeAsync(10_000);
  first.setActive(false);
  second.setActive(true);

  expect(renew).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(19_999);
  expect(renew).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(renew).toHaveBeenCalledTimes(2);
  expect(release).not.toHaveBeenCalled();
});

it("releases the device lease on real suspension", async () => {
  const release = vi.fn(() => accepted);
  const storage = new MemoryStorage();
  const lease = new ForegroundLease({
    renew: vi.fn(() => accepted),
    release,
    storage,
  });
  lease.setDevice(device);
  lease.setActive(true);
  await vi.runAllTicks();

  lease.release();

  expect(release).toHaveBeenCalledWith(device, "device");
  expect(storage.values.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("reports a renewal failure without exposing its payload", async () => {
  const renew = vi
    .fn<ForegroundLeaseOptions["renew"]>()
    .mockResolvedValueOnce({ ok: true, value: null })
    .mockResolvedValueOnce({
      ok: false,
      error: { kind: "unavailable" },
    });
  const onAction = vi.fn();
  const lease = new ForegroundLease({
    renew,
    release: vi.fn(() => accepted),
    onAction,
  });

  lease.setDevice(device);
  lease.setActive(true);
  await vi.advanceTimersByTimeAsync(30_000);

  expect(onAction.mock.calls).toEqual([
    ["acquire", "sent"],
    ["acquire", "ok"],
    ["renew", "sent"],
    ["renew", "unavailable"],
  ]);
});

it("backs failed renewals off with jitter and honours Retry-After", async () => {
  const renew = vi
    .fn<ForegroundLeaseOptions["renew"]>()
    .mockResolvedValueOnce({
      ok: false,
      error: { kind: "capacity", retryAfterMs: 4_000 },
    })
    .mockResolvedValueOnce({
      ok: false,
      error: { kind: "unavailable" },
    })
    .mockResolvedValue({ ok: true, value: null });
  const lease = new ForegroundLease({
    renew,
    release: vi.fn(() => accepted),
    random: () => 0,
  });

  lease.setDevice(device);
  lease.setActive(true);
  await vi.advanceTimersByTimeAsync(3_999);
  expect(renew).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(renew).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(999);
  expect(renew).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(renew).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(renew).toHaveBeenCalledTimes(4);
});

it("does not leave a heartbeat after an in-flight renewal loses ownership", async () => {
  let finishRenewal = () => {};
  const renewing = new Promise<
    Awaited<ReturnType<ForegroundLeaseOptions["renew"]>>
  >((resolve) => {
    finishRenewal = () => resolve({ ok: true, value: null });
  });
  const renew = vi.fn(() => renewing);
  const release = vi.fn(() => accepted);
  const lease = new ForegroundLease({ renew, release });
  lease.setDevice(device);
  lease.setActive(true);

  lease.setActive(false);
  finishRenewal();
  await renewing;

  expect(release).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

type ForegroundLeaseOptions = ConstructorParameters<typeof ForegroundLease>[0];
