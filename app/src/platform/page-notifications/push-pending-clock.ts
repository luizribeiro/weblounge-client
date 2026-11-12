/**
 * Measures how long a network's push outcome has been in flight: since push setup last started
 * or the engine last asked for that network's route, whichever is later.
 */
export class PushPendingClock {
  readonly #now: () => number;
  #setupStartedAtMs: number;
  readonly #routeRequestedAtMs = new Map<number, number>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#setupStartedAtMs = now();
  }

  restartSetup(): void {
    this.#setupStartedAtMs = this.#now();
  }

  routeRequested(networkId: number): void {
    this.#routeRequestedAtMs.set(networkId, this.#now());
  }

  pendingForMs(networkId: number): number {
    const since = Math.max(
      this.#setupStartedAtMs,
      this.#routeRequestedAtMs.get(networkId) ?? 0,
    );
    return this.#now() - since;
  }
}
