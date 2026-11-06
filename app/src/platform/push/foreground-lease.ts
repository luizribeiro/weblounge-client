import type { RelayDevice, RelayFailure, RelayResult } from "./relay-client";

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
  readonly #onAction: NonNullable<ForegroundLeaseOptions["onAction"]>;
  #device: RelayDevice | undefined;
  #foreground = false;
  #acquired = false;
  #disposed = false;
  #generation = 0;
  #timer: number | undefined;

  constructor(options: ForegroundLeaseOptions) {
    this.#renew = options.renew;
    this.#release = options.release;
    this.#tabId = options.tabId ?? crypto.randomUUID();
    this.#setTimer = options.setTimer ?? window.setTimeout.bind(window);
    this.#clearTimer = options.clearTimer ?? window.clearTimeout.bind(window);
    this.#onAction = options.onAction ?? (() => {});
  }

  setDevice(device: RelayDevice): void {
    if (this.#disposed) return;
    const previous = this.#device;
    this.#device = device;
    if (previous?.id === device.id && previous.secret === device.secret) return;
    this.#acquired = false;
    if (previous !== undefined && this.#foreground) {
      void this.#release(previous, this.#tabId);
    }
    if (this.#foreground) this.#startRenewal();
  }

  setForeground(foreground: boolean): void {
    if (this.#disposed || foreground === this.#foreground) return;
    this.#foreground = foreground;
    if (!foreground) this.#acquired = false;
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
      .then((result) => {
        this.#onAction(action, result.ok ? "ok" : result.error.kind);
        if (
          result.ok &&
          !this.#disposed &&
          this.#foreground &&
          generation === this.#generation
        ) {
          this.#acquired = true;
        }
      })
      .catch(() => this.#onAction(action, "unavailable"))
      .finally(() => {
        if (
          this.#disposed ||
          !this.#foreground ||
          generation !== this.#generation
        ) {
          return;
        }
        this.#timer = this.#setTimer(
          () => this.#startRenewal(),
          heartbeatMilliseconds,
        );
      });
  }

  #clearHeartbeat(): void {
    if (this.#timer === undefined) return;
    this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }
}
