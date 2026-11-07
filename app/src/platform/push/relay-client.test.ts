import { describe, expect, it, vi } from "vitest";
import { RelayClient, relayRetryDelay } from "./relay-client";

const target = {
  endpoint: "https://fcm.googleapis.com/fcm/send/subscription",
  p256dh: "browser-key",
  auth: "browser-auth",
};

describe("relay client", () => {
  it("creates a device with the member session and routes with its device secret", async () => {
    const fetchRelay = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { id: "device-1", secret: "device-secret" },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { id: "route-1", endpoint: "https://push.example.test/v1/r/route-1" },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RelayClient("https://push.example.test", fetchRelay);

    const device = await client.createDevice("member-session", target);
    expect(device).toEqual({
      ok: true,
      value: { id: "device-1", secret: "device-secret" },
    });
    if (!device.ok) throw new Error("device creation failed");
    const route = await client.ensureRoute(
      device.value,
      "home-vapid",
      "known-route",
    );
    expect(route).toEqual({
      ok: true,
      value: {
        id: "route-1",
        endpoint: "https://push.example.test/v1/r/route-1",
      },
    });
    await expect(
      client.activateRoute(device.value, "route-1"),
    ).resolves.toEqual({ ok: true, value: null });

    expect(fetchRelay.mock.calls).toEqual([
      [
        "https://push.example.test/v1/devices",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer member-session",
          }),
          body: JSON.stringify({ target: { platform: "web_push", ...target } }),
        }),
      ],
      [
        "https://push.example.test/v1/devices/device-1/routes",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer device-secret",
          }),
          body: JSON.stringify({
            home_vapid: "home-vapid",
            my_route_id: "known-route",
          }),
        }),
      ],
      [
        "https://push.example.test/v1/routes/route-1/active",
        expect.objectContaining({ method: "PUT" }),
      ],
    ]);
  });

  it.each([
    [401, "unauthorized"],
    [404, "dead_route"],
    [410, "gone"],
    [409, "capacity"],
    [429, "capacity"],
    [400, "invalid_request"],
    [503, "unavailable"],
  ] as const)("returns a typed %s failure", async (status, kind) => {
    const client = new RelayClient(
      "https://push.example.test",
      vi.fn(async () => new Response(null, { status })),
    );
    await expect(
      client.deleteRoute({ id: "device-1", secret: "secret" }, "route-1"),
    ).resolves.toEqual({ ok: false, error: { kind } });
  });

  it("reads Retry-After without weakening exponential jitter", async () => {
    const client = new RelayClient(
      "https://push.example.test",
      vi.fn(
        async () =>
          new Response(null, {
            status: 429,
            headers: { "Retry-After": "12" },
          }),
      ),
    );

    await expect(
      client.renewLease({ id: "device-1", secret: "secret" }, "tab-1"),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "capacity", retryAfterMs: 12_000 },
    });
    expect(relayRetryDelay(0, 0, () => 0)).toBe(500);
    expect(relayRetryDelay(4, 12_000, () => 0)).toBe(12_000);
    expect(relayRetryDelay(4, 0, () => 1)).toBe(16_000);
  });

  it("gates every later fetch after an opaque network failure", async () => {
    let now = 0;
    const waits: number[] = [];
    const fetchRelay = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("opaque network failure"))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new RelayClient("https://push.example.test", fetchRelay, {
      random: () => 0,
      now: () => now,
      wait: async (delay) => {
        waits.push(delay);
        now += delay;
      },
    });
    const device = { id: "device-1", secret: "secret" };

    await expect(client.renewLease(device, "tab-1")).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
    await expect(client.updateTarget(device, target)).resolves.toEqual({
      ok: true,
      value: null,
    });

    expect(waits).toEqual([500]);
  });

  it("keeps lease traffic outside the synchronization gate", async () => {
    let now = 0;
    const waits: number[] = [];
    const fetchRelay = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("opaque network failure"))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new RelayClient("https://push.example.test", fetchRelay, {
      random: () => 0,
      now: () => now,
      wait: async (delay) => {
        waits.push(delay);
        now += delay;
      },
    });
    const device = { id: "device-1", secret: "secret" };

    await client.updateTarget(device, target);
    await client.renewLease(device, "tab-1");

    expect(waits).toEqual([]);
    expect(fetchRelay).toHaveBeenCalledTimes(2);
  });

  it("rechecks a synchronization gate after every wait", async () => {
    let now = 0;
    const waits: number[] = [];
    const fetchRelay = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("opaque network failure"))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new RelayClient("https://push.example.test", fetchRelay, {
      random: () => 0,
      now: () => now,
      wait: async (delay) => {
        waits.push(delay);
        now += waits.length === 1 ? delay / 2 : delay;
      },
    });
    const device = { id: "device-1", secret: "secret" };

    await client.updateTarget(device, target);
    await client.deleteDevice(device);

    expect(waits).toEqual([500, 250]);
  });

  it("does not gate later fetches after a permanent client failure", async () => {
    let now = 0;
    const waits: number[] = [];
    const fetchRelay = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new RelayClient("https://push.example.test", fetchRelay, {
      random: () => 0,
      now: () => now,
      wait: async (delay) => {
        waits.push(delay);
        now += delay;
      },
    });
    const device = { id: "device-1", secret: "secret" };

    await expect(client.updateTarget(device, target)).resolves.toEqual({
      ok: false,
      error: { kind: "invalid_request" },
    });
    await expect(client.deleteDevice(device)).resolves.toEqual({
      ok: true,
      value: null,
    });

    expect(waits).toEqual([]);
  });

  it("parses bounded Retry-After values with the injected clock", async () => {
    const now = Date.parse("2026-11-07T12:00:00Z");
    const fetchRelay = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "Sat, 07 Nov 2026 12:00:12 GMT" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "Retry-After": "" } }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "Retry-After": "-1" } }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "86400" },
        }),
      );
    const client = new RelayClient("https://push.example.test", fetchRelay, {
      now: () => now,
      random: () => 0,
      wait: async () => {},
    });
    const device = { id: "device-1", secret: "secret" };

    await expect(client.updateTarget(device, target)).resolves.toMatchObject({
      error: { retryAfterMs: 12_000 },
    });
    await expect(client.updateTarget(device, target)).resolves.toEqual({
      ok: false,
      error: { kind: "capacity" },
    });
    await expect(client.updateTarget(device, target)).resolves.toEqual({
      ok: false,
      error: { kind: "capacity" },
    });
    await expect(client.updateTarget(device, target)).resolves.toMatchObject({
      error: { retryAfterMs: 10 * 60_000 },
    });
  });

  it("classifies network and malformed response failures as unavailable", async () => {
    const unreachable = new RelayClient(
      "https://push.example.test",
      vi.fn(async () => {
        throw new TypeError("network failed");
      }),
    );
    await expect(unreachable.createDevice("session", target)).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });

    const malformed = new RelayClient(
      "https://push.example.test",
      vi.fn(async () =>
        Response.json({ id: "missing secret" }, { status: 201 }),
      ),
    );
    await expect(malformed.createDevice("session", target)).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable" },
    });
  });

  it("renews with authorization and releases through a beacon form", async () => {
    const fetchRelay = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const sendBeacon = vi.fn<Navigator["sendBeacon"]>(() => true);
    const onBeaconSent = vi.fn();
    const client = new RelayClient("https://push.example.test", fetchRelay);
    const device = { id: "device/1", secret: "device-secret" };

    await expect(client.renewLease(device, "tab-1")).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(
      client.releaseLease(device, "tab-1", sendBeacon, onBeaconSent),
    ).resolves.toEqual({ ok: true, value: null });

    expect(fetchRelay).toHaveBeenCalledWith(
      "https://push.example.test/v1/devices/device%2F1/lease",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer device-secret",
        }),
        body: JSON.stringify({ tab_id: "tab-1" }),
      }),
    );
    const [url, body] = sendBeacon.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://push.example.test/v1/devices/device%2F1/lease/release",
    );
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(String(body)).toBe("secret=device-secret&tab_id=tab-1");
    expect(onBeaconSent).toHaveBeenCalledOnce();
  });

  it("updates and deletes devices and drains exact dead endpoints", async () => {
    const fetchRelay = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({
          endpoints: [
            {
              id: "dead-route",
              endpoint: "https://push.example.test/v1/r/dead-route",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new RelayClient("https://push.example.test", fetchRelay);
    const device = { id: "device-1", secret: "device-secret" };

    await expect(client.updateTarget(device, target)).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(
      client.takeDeadEndpoints(device, "home/vapid"),
    ).resolves.toEqual({
      ok: true,
      value: [
        {
          id: "dead-route",
          endpoint: "https://push.example.test/v1/r/dead-route",
        },
      ],
    });
    await expect(
      client.acknowledgeDeadEndpoints(device, "home/vapid", ["dead-route"]),
    ).resolves.toEqual({ ok: true, value: null });
    await expect(client.deleteDevice(device)).resolves.toEqual({
      ok: true,
      value: null,
    });

    expect(fetchRelay.mock.calls.map(([, init]) => init?.method)).toEqual([
      "PUT",
      "GET",
      "POST",
      "DELETE",
    ]);
    expect(fetchRelay.mock.calls[1]?.[0]).toBe(
      "https://push.example.test/v1/devices/device-1/dead-endpoints?home_vapid=home%2Fvapid",
    );
    expect(fetchRelay.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({
        home_vapid: "home/vapid",
        route_ids: ["dead-route"],
      }),
    );
  });

  it("falls back to a keepalive release when sendBeacon declines it", async () => {
    const fetchRelay = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new RelayClient("https://push.example.test", fetchRelay);

    await client.releaseLease(
      { id: "device-1", secret: "secret" },
      "tab-1",
      () => false,
    );

    expect(fetchRelay).toHaveBeenCalledWith(
      "https://push.example.test/v1/devices/device-1/lease/release",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        body: JSON.stringify({ tab_id: "tab-1" }),
      }),
    );
  });
});
