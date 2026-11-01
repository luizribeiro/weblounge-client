export type SessionTokenFailureKind =
  | "authorization_required"
  | "endpoint_missing"
  | "invalid_response"
  | "transient";

export class SessionTokenError extends Error {
  constructor(
    readonly kind: SessionTokenFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "SessionTokenError";
  }
}

export interface SessionAccessToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

export class SessionTokenProvider {
  constructor(
    readonly endpoint: string,
    private readonly fetchToken: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(): Promise<SessionAccessToken> {
    let response: Response;
    try {
      response = await this.fetchToken.call(globalThis, this.endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {
      throw new SessionTokenError(
        "transient",
        "Couldn't reach the sign-in service. Try again.",
      );
    }

    if (response.status === 401) {
      throw new SessionTokenError(
        "authorization_required",
        "Your member session needs sign-in.",
      );
    }
    if (response.status === 404) {
      throw new SessionTokenError(
        "endpoint_missing",
        "Session sign-in is not available yet.",
      );
    }
    if (response.status === 429) {
      throw new SessionTokenError(
        "transient",
        "The sign-in service is busy. Try again shortly.",
      );
    }
    if (!response.ok) {
      throw new SessionTokenError(
        "invalid_response",
        `The sign-in service returned ${response.status}.`,
      );
    }

    const value = await responseJson(response);
    if (
      typeof value.access_token !== "string" ||
      value.access_token === "" ||
      value.token_type !== "Bearer" ||
      typeof value.expires_in !== "number" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0
    ) {
      throw new SessionTokenError(
        "invalid_response",
        "The sign-in service returned an invalid access token.",
      );
    }
    return {
      accessToken: value.access_token,
      expiresAt: this.now() + value.expires_in * 1_000,
    };
  }
}

export function requiresAuthorization(error: unknown): boolean {
  return (
    error instanceof SessionTokenError &&
    (error.kind === "authorization_required" ||
      error.kind === "endpoint_missing")
  );
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // The typed deployment error below is more useful than a JSON parser detail.
  }
  throw new SessionTokenError(
    "invalid_response",
    "The sign-in service returned an invalid response.",
  );
}
