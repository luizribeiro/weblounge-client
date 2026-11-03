import { describe, expect, it, vi } from "vitest";
import { RelayClient } from "./relay-client";

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
    const route = await client.createRoute(device.value, "home-vapid");
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
          body: JSON.stringify({ home_vapid: "home-vapid" }),
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
    [409, "capacity"],
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
});
