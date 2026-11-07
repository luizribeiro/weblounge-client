import {
  type RelayDevice,
  type RelayFailure,
  type RelayResult,
  relayRetryDelay,
} from "./relay-client";

const heartbeatMilliseconds = 30_000;
const tabIdStorageKey = "weblounge-push-tab-id";

export function foregroundLeaseTabId(
  storage: Pick<Storage, "getItem" | "setItem"> = sessionStorage,
  create: () => string = () => crypto.randomUUID(),
): string {
  try {
    const existing = storage.getItem(tabIdStorageKey);
    if (existing !== null) return existing;
    const created = create();
    storage.setItem(tabIdStorageKey, created);
    return created;
  } catch {
    return create();
  }
}

interface ForegroundLeaseOptions {
  readonly renew: (
    device: RelayDevice,
    tabId: string,
  ) => Promise<RelayResult<null>>;
  readonly release: (
    device: RelayDevice,
    tabId: string,
  ) => Promise<RelayResult<null>>;
  readonly tabId?: string;
  readonly setTimer?: typeof window.setTimeout;
  readonly clearTimer?: typeof window.clearTimeout;
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
  readonly #tabId: string;
  readonly #setTimer: typeof window.setTimeout;
  readonly #clearTimer: typeof window.clearTimeout;
  readonly #random: () => number;
  readonly #onAction: NonNullable<ForegroundLeaseOptions["onAction"]>;
  #device: RelayDevice | undefined;
  #foreground = false;
  #acquired = false;
  #disposed = false;
  #generation = 0;
  #failureAttempts = 0;
  #timer: number | undefined;

  constructor(options: ForegroundLeaseOptions) {
    this.#renew = options.renew;
    this.#release = options.release;
    this.#tabId = options.tabId ?? crypto.randomUUID();
    this.#setTimer = options.setTimer ?? window.setTimeout.bind(window);
    this.#clearTimer = options.clearTimer ?? window.clearTimeout.bind(window);
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
    if (previous !== undefined && this.#foreground) {
      void this.#release(previous, this.#tabId);
    }
    if (this.#foreground) this.#startRenewal();
  }

  setForeground(foreground: boolean): void {
    if (this.#disposed || foreground === this.#foreground) return;
    this.#foreground = foreground;
    if (!foreground) this.#acquired = false;
    this.#failureAttempts = 0;
    this.#generation += 1;
    this.#clearHeartbeat();
    const device = this.#device;
    if (foreground) this.#startRenewal();
    else if (device !== undefined) void this.#release(device, this.#tabId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#acquired = false;
    this.#generation += 1;
    this.#clearHeartbeat();
    if (this.#foreground && this.#device !== undefined) {
      void this.#release(this.#device, this.#tabId);
    }
  }

  #startRenewal(): void {
    const device = this.#device;
    if (!this.#foreground || device === undefined) return;
    const generation = ++this.#generation;
    const action = this.#acquired ? "renew" : "acquire";
    this.#onAction(action, "sent");
    void this.#renew(device, this.#tabId)
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
          this.#foreground &&
          generation === this.#generation
        ) {
          this.#acquired = true;
          this.#failureAttempts = 0;
        }
        if (
          this.#disposed ||
          !this.#foreground ||
          generation !== this.#generation
        ) {
          return;
        }
        this.#timer = this.#setTimer(() => this.#startRenewal(), retryDelay);
      });
  }

  #clearHeartbeat(): void {
    if (this.#timer === undefined) return;
    this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }
}
