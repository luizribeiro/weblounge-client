import {
  type RelayDevice,
  type RelayFailure,
  type RelayResult,
  relayRetryDelay,
} from "./relay-client";

const heartbeatMilliseconds = 30_000;
const leaseId = "device";
const renewalKey = "weblounge-push-lease-renewed";

interface ForegroundLeaseOptions {
  readonly renew: (
    device: RelayDevice,
    leaseId: string,
  ) => Promise<RelayResult<null>>;
  readonly release: (
    device: RelayDevice,
    leaseId: string,
  ) => Promise<RelayResult<null>>;
  readonly storage?: Pick<Storage, "getItem" | "removeItem" | "setItem">;
  readonly setTimer?: typeof window.setTimeout;
  readonly clearTimer?: typeof window.clearTimeout;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly onAction?:
    | ((
        action: "acquire" | "renew",
        result: "sent" | "ok" | RelayFailure["kind"],
      ) => void)
    | undefined;
}

export class ForegroundLease {
  readonly #renew: ForegroundLeaseOptions["renew"];
  readonly #release: ForegroundLeaseOptions["release"];
  readonly #storage: NonNullable<ForegroundLeaseOptions["storage"]>;
  readonly #setTimer: typeof window.setTimeout;
  readonly #clearTimer: typeof window.clearTimeout;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #onAction: NonNullable<ForegroundLeaseOptions["onAction"]>;
  #device: RelayDevice | undefined;
  #active = false;
  #acquired = false;
  #disposed = false;
  #generation = 0;
  #failureAttempts = 0;
  #timer: number | undefined;

  constructor(options: ForegroundLeaseOptions) {
    this.#renew = options.renew;
    this.#release = options.release;
    this.#storage = options.storage ?? localStorage;
    this.#setTimer = options.setTimer ?? window.setTimeout.bind(window);
    this.#clearTimer = options.clearTimer ?? window.clearTimeout.bind(window);
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#onAction = options.onAction ?? (() => {});
  }

  setDevice(device: RelayDevice): void {
    if (this.#disposed) return;
    const previous = this.#device;
    this.#device = device;
    if (previous?.id === device.id && previous.secret === device.secret) return;
    this.#acquired = false;
    this.#failureAttempts = 0;
    this.#generation += 1;
    this.#clearHeartbeat();
    if (previous !== undefined && this.#active) {
      this.#forgetRenewal();
      void this.#release(previous, leaseId);
    }
    if (this.#active) this.#resume();
  }

  setActive(active: boolean): void {
    if (this.#disposed || active === this.#active) return;
    this.#active = active;
    this.#failureAttempts = 0;
    this.#generation += 1;
    this.#clearHeartbeat();
    if (active) this.#resume();
  }

  release(): void {
    if (!this.#active || this.#device === undefined) return;
    const device = this.#device;
    this.#active = false;
    this.#acquired = false;
    this.#generation += 1;
    this.#clearHeartbeat();
    this.#forgetRenewal();
    void this.#release(device, leaseId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.release();
    this.#disposed = true;
  }

  #resume(): void {
    const device = this.#device;
    if (!this.#active || device === undefined) return;
    const remaining = this.#renewalRemaining();
    if (remaining > 0) {
      this.#acquired = true;
      this.#timer = this.#setTimer(() => {
        this.#timer = undefined;
        this.#startRenewal();
      }, remaining);
      return;
    }
    this.#startRenewal();
  }

  #startRenewal(): void {
    const device = this.#device;
    if (!this.#active || device === undefined) return;
    const generation = ++this.#generation;
    const action = this.#acquired ? "renew" : "acquire";
    this.#rememberRenewal();
    this.#onAction(action, "sent");
    void this.#renew(device, leaseId)
      .catch(
        (): RelayResult<null> => ({
          ok: false,
          error: { kind: "unavailable" },
        }),
      )
      .then((result) => {
        this.#onAction(action, result.ok ? "ok" : result.error.kind);
        const retryDelay = result.ok
          ? heartbeatMilliseconds
          : relayRetryDelay(
              this.#failureAttempts++,
              result.error.retryAfterMs,
              this.#random,
            );
        if (
          result.ok &&
          !this.#disposed &&
          this.#active &&
          generation === this.#generation
        ) {
          this.#acquired = true;
          this.#failureAttempts = 0;
        } else if (
          !result.ok &&
          !this.#disposed &&
          this.#active &&
          generation === this.#generation
        ) {
          this.#forgetRenewal();
        }
        if (
          this.#disposed ||
          !this.#active ||
          generation !== this.#generation
        ) {
          return;
        }
        this.#timer = this.#setTimer(() => {
          this.#timer = undefined;
          this.#startRenewal();
        }, retryDelay);
      });
  }

  #renewalRemaining(): number {
    try {
      const stored = this.#storage.getItem(renewalKey);
      if (stored === null) return 0;
      const renewedAt = Number(stored);
      if (!Number.isFinite(renewedAt)) return 0;
      return Math.min(
        heartbeatMilliseconds,
        Math.max(0, renewedAt + heartbeatMilliseconds - this.#now()),
      );
    } catch {
      return 0;
    }
  }

  #rememberRenewal(): void {
    try {
      this.#storage.setItem(renewalKey, String(this.#now()));
    } catch {
      return;
    }
  }

  #forgetRenewal(): void {
    try {
      this.#storage.removeItem(renewalKey);
    } catch {
      return;
    }
  }

  #clearHeartbeat(): void {
    if (this.#timer === undefined) return;
    this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }
}
