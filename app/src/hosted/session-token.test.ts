import { describe, expect, it, vi } from "vitest";
import {
  requiresAuthorization,
  SessionTokenError,
  SessionTokenProvider,
} from "./session-token";

const endpoint = "https://members.weblounge.org/oauth/session-token";

describe("hosted session token provider", () => {
  it("posts an empty credentialed JSON request and validates the bearer", async () => {
    const fetchToken = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(
        Response.json({
          access_token: "session-access-token",
          token_type: "Bearer",
          expires_in: 900,
        }),
      );
    });
    const provider = new SessionTokenProvider(endpoint, fetchToken, () => 50);

    await expect(provider.acquire()).resolves.toEqual({
      accessToken: "session-access-token",
      expiresAt: 900_050,
    });
    expect(fetchToken).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    [401, "authorization_required", true],
    [404, "endpoint_missing", true],
    [429, "transient", false],
  ] as const)(
    "classifies HTTP %s without exposing a response body",
    async (status, kind, authorize) => {
      const provider = new SessionTokenProvider(
        endpoint,
        vi.fn(async () =>
          Response.json(
            { error: status === 401 ? "login_required" : "invalid_request" },
            { status },
          ),
        ),
      );

      const error = await provider.acquire().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(SessionTokenError);
      expect(error).toMatchObject({ kind });
      expect(requiresAuthorization(error)).toBe(authorize);
    },
  );

  it("keeps network failures transient", async () => {
    const provider = new SessionTokenProvider(
      endpoint,
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(provider.acquire()).rejects.toMatchObject({
      kind: "transient",
    });
  });

  it("does not cache a token between connection attempts", async () => {
    const fetchToken = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "first-token",
          token_type: "Bearer",
          expires_in: 900,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "reconnect-token",
          token_type: "Bearer",
          expires_in: 900,
        }),
      );
    const provider = new SessionTokenProvider(endpoint, fetchToken);

    await expect(provider.acquire()).resolves.toMatchObject({
      accessToken: "first-token",
    });
    await expect(provider.acquire()).resolves.toMatchObject({
      accessToken: "reconnect-token",
    });
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed successful responses", async () => {
    const provider = new SessionTokenProvider(
      endpoint,
      vi.fn(async () =>
        Response.json({
          access_token: "token",
          token_type: "bearer",
          expires_in: 900,
        }),
      ),
    );

    await expect(provider.acquire()).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });
});
