import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ForegroundLease, foregroundLeaseTabId } from "./foreground-lease";

const device = { id: "device-1", secret: "device-secret" };
const accepted = Promise.resolve({ ok: true as const, value: null });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("keeps one lease identity across a tab reload", () => {
  const storage = new Map<string, string>();
  const adapter = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  };

  expect(foregroundLeaseTabId(adapter, () => "tab-1")).toBe("tab-1");
  expect(foregroundLeaseTabId(adapter, () => "tab-2")).toBe("tab-1");
});

it("renews only while foreground and releases immediately on hide", async () => {
  const renew = vi.fn(() => accepted);
  const release = vi.fn(() => accepted);
  const onAction = vi.fn();
  const lease = new ForegroundLease({
    renew,
    release,
    tabId: "tab-1",
    onAction,
  });

  lease.setDevice(device);
  lease.setForeground(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(renew).toHaveBeenCalledTimes(2);
  expect(onAction.mock.calls).toEqual([
    ["acquire", "sent"],
    ["acquire", "ok"],
    ["renew", "sent"],
    ["renew", "ok"],
  ]);

  lease.setForeground(false);
  expect(release).toHaveBeenCalledWith(device, "tab-1");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(renew).toHaveBeenCalledTimes(2);
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
    tabId: "tab-1",
    onAction,
  });

  lease.setDevice(device);
  lease.setForeground(true);
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
    tabId: "tab-1",
    random: () => 0,
  });

  lease.setDevice(device);
  lease.setForeground(true);
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
