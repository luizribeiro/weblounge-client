import type { WebPushTarget } from "./subscription";

export interface RelayDevice {
  readonly id: string;
  readonly secret: string;
}

export interface RelayRoute {
  readonly id: string;
  readonly endpoint: string;
}

export type RelayFailure =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "dead_route" }
  | { readonly kind: "capacity" }
  | { readonly kind: "invalid_request" }
  | { readonly kind: "unavailable" };

export type RelayResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RelayFailure };

export class RelayClient {
  constructor(
    readonly origin: string,
    private readonly fetchRelay: typeof fetch = fetch,
  ) {}

  createDevice(
    sessionToken: string,
    target: WebPushTarget,
  ): Promise<RelayResult<RelayDevice>> {
    return this.request(
      "/v1/devices",
      sessionToken,
      "POST",
      {
        target: { platform: "web_push", ...target },
      },
      isDevice,
    );
  }

  createRoute(
    device: RelayDevice,
    homeVapid: string,
  ): Promise<RelayResult<RelayRoute>> {
    return this.request(
      `/v1/devices/${encodeURIComponent(device.id)}/routes`,
      device.secret,
      "POST",
      { home_vapid: homeVapid },
      isRoute,
    );
  }

  activateRoute(
    device: RelayDevice,
    routeId: string,
  ): Promise<RelayResult<null>> {
    return this.request(
      `/v1/routes/${encodeURIComponent(routeId)}/active`,
      device.secret,
      "PUT",
      undefined,
      isNull,
    );
  }

  deleteRoute(
    device: RelayDevice,
    routeId: string,
  ): Promise<RelayResult<null>> {
    return this.request(
      `/v1/routes/${encodeURIComponent(routeId)}`,
      device.secret,
      "DELETE",
      undefined,
      isNull,
    );
  }

  private async request<T>(
    path: string,
    bearer: string,
    method: "POST" | "PUT" | "DELETE",
    body: Readonly<Record<string, unknown>> | undefined,
    decode: (value: unknown) => value is T,
  ): Promise<RelayResult<T>> {
    let response: Response;
    try {
      response = await this.fetchRelay.call(
        globalThis,
        `${this.origin}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${bearer}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    } catch {
      return { ok: false, error: { kind: "unavailable" } };
    }
    if (!response.ok) return { ok: false, error: failure(response.status) };
    if (response.status === 204) return { ok: true, value: null as T };
    try {
      const value: unknown = await response.json();
      return decode(value)
        ? { ok: true, value }
        : { ok: false, error: { kind: "unavailable" } };
    } catch {
      return { ok: false, error: { kind: "unavailable" } };
    }
  }
}

function failure(status: number): RelayFailure {
  if (status === 401) return { kind: "unauthorized" };
  if (status === 404) return { kind: "dead_route" };
  if (status === 409) return { kind: "capacity" };
  if (status === 400) return { kind: "invalid_request" };
  return { kind: "unavailable" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDevice(value: unknown): value is RelayDevice {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.secret === "string"
  );
}

function isRoute(value: unknown): value is RelayRoute {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.endpoint === "string"
  );
}

function isNull(value: unknown): value is null {
  return value === null;
}
