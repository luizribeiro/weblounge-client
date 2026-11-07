import type { WebPushTarget } from "./subscription";

export interface RelayDevice {
  readonly id: string;
  readonly secret: string;
}

export interface RelayRoute {
  readonly id: string;
  readonly endpoint: string;
}

export interface RelayDeadEndpoint {
  readonly id: string;
  readonly endpoint: string;
}

type RelayFailureKind =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "gone" }
  | { readonly kind: "dead_route" }
  | { readonly kind: "capacity" }
  | { readonly kind: "invalid_request" }
  | { readonly kind: "unavailable" };

export type RelayFailure = RelayFailureKind & {
  readonly retryAfterMs?: number;
};

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

  updateTarget(
    device: RelayDevice,
    target: WebPushTarget,
  ): Promise<RelayResult<null>> {
    return this.request(
      `/v1/devices/${encodeURIComponent(device.id)}/target`,
      device.secret,
      "PUT",
      { target: { platform: "web_push", ...target } },
      isNull,
    );
  }

  deleteDevice(device: RelayDevice): Promise<RelayResult<null>> {
    return this.request(
      `/v1/devices/${encodeURIComponent(device.id)}`,
      device.secret,
      "DELETE",
      undefined,
      isNull,
    );
  }

  ensureRoute(
    device: RelayDevice,
    homeVapid: string,
    myRouteId?: string,
  ): Promise<RelayResult<RelayRoute>> {
    return this.request(
      `/v1/devices/${encodeURIComponent(device.id)}/routes`,
      device.secret,
      "POST",
      {
        home_vapid: homeVapid,
        ...(myRouteId === undefined ? {} : { my_route_id: myRouteId }),
      },
      isRoute,
    );
  }

  takeDeadEndpoints(
    device: RelayDevice,
    homeVapid: string,
  ): Promise<RelayResult<readonly RelayDeadEndpoint[]>> {
    const query = new URLSearchParams({ home_vapid: homeVapid });
    return this.request(
      `/v1/devices/${encodeURIComponent(device.id)}/dead-endpoints?${query}`,
      device.secret,
      "GET",
      undefined,
      isDeadEndpoints,
    ).then((result) =>
      result.ok ? { ok: true, value: result.value.endpoints } : result,
    );
  }

  acknowledgeDeadEndpoints(
    device: RelayDevice,
    homeVapid: string,
    routeIds: readonly string[],
  ): Promise<RelayResult<null>> {
    return this.request(
      `/v1/devices/${encodeURIComponent(device.id)}/dead-endpoints`,
      device.secret,
      "POST",
      { home_vapid: homeVapid, route_ids: [...routeIds] },
      isNull,
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

  renewLease(device: RelayDevice, tabId: string): Promise<RelayResult<null>> {
    return this.request(
      `/v1/devices/${encodeURIComponent(device.id)}/lease`,
      device.secret,
      "POST",
      { tab_id: tabId },
      isNull,
    );
  }

  releaseLease(
    device: RelayDevice,
    tabId: string,
    sendBeacon:
      | Navigator["sendBeacon"]
      | undefined = navigator.sendBeacon?.bind(navigator),
    onBeaconSent: (() => void) | undefined = undefined,
  ): Promise<RelayResult<null>> {
    const path = `/v1/devices/${encodeURIComponent(device.id)}/lease/release`;
    if (sendBeacon !== undefined) {
      const body = new URLSearchParams({
        secret: device.secret,
        tab_id: tabId,
      });
      if (sendBeacon(`${this.origin}${path}`, body)) {
        onBeaconSent?.();
        return Promise.resolve({ ok: true, value: null });
      }
    }
    return this.request(
      path,
      device.secret,
      "POST",
      { tab_id: tabId },
      isNull,
      true,
    );
  }

  private async request<T>(
    path: string,
    bearer: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body: Readonly<Record<string, unknown>> | undefined,
    decode: (value: unknown) => value is T,
    keepalive = false,
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
          ...(keepalive ? { keepalive: true } : {}),
        },
      );
    } catch {
      return { ok: false, error: { kind: "unavailable" } };
    }
    if (!response.ok)
      return {
        ok: false,
        error: failure(
          response.status,
          retryAfterMilliseconds(response.headers.get("Retry-After")),
        ),
      };
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

function failure(status: number, retryAfterMs?: number): RelayFailure {
  const detail = retryAfterMs === undefined ? {} : { retryAfterMs };
  if (status === 401) return { kind: "unauthorized", ...detail };
  if (status === 410) return { kind: "gone", ...detail };
  if (status === 404) return { kind: "dead_route", ...detail };
  if (status === 409 || status === 429) return { kind: "capacity", ...detail };
  if (status === 400) return { kind: "invalid_request", ...detail };
  return { kind: "unavailable", ...detail };
}

export function relayRetryDelay(
  attempt: number,
  retryAfterMs = 0,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(5 * 60_000, 1_000 * 2 ** attempt);
  const jittered = exponential * (0.5 + random() * 0.5);
  return Math.max(retryAfterMs, Math.round(jittered));
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
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

function isDeadEndpoints(
  value: unknown,
): value is { readonly endpoints: readonly RelayDeadEndpoint[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.endpoints) &&
    value.endpoints.every(
      (endpoint) =>
        isRecord(endpoint) &&
        typeof endpoint.id === "string" &&
        typeof endpoint.endpoint === "string",
    )
  );
}

function isNull(value: unknown): value is null {
  return value === null;
}
