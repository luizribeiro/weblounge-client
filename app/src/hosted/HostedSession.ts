import type { HostedNetworkConfig } from "../engine/generated/HostedNetworkConfig";

export class OneShotAccessToken {
  #value: string | undefined;

  constructor(
    value: string,
    readonly expiresAt: number,
  ) {
    this.#value = value;
  }

  take(): string {
    const value = this.#value;
    this.#value = undefined;
    if (value === undefined)
      throw new Error("hosted access token was already consumed");
    return value;
  }
}

export interface HostedSession {
  network: HostedNetworkConfig;
  token: OneShotAccessToken;
}
