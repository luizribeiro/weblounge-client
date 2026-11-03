import type { RelayDevice, RelayResult } from "./relay-client";

const heartbeatMilliseconds = 30_000;

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
}

export class ForegroundLease {
  readonly #renew: ForegroundLeaseOptions["renew"];
  readonly #release: ForegroundLeaseOptions["release"];
  readonly #tabId: string;
  readonly #setTimer: typeof window.setTimeout;
  readonly #clearTimer: typeof window.clearTimeout;
  #device: RelayDevice | undefined;
  #foreground = false;
  #disposed = false;
  #generation = 0;
  #timer: number | undefined;

  constructor(options: ForegroundLeaseOptions) {
    this.#renew = options.renew;
    this.#release = options.release;
    this.#tabId = options.tabId ?? crypto.randomUUID();
    this.#setTimer = options.setTimer ?? window.setTimeout.bind(window);
    this.#clearTimer = options.clearTimer ?? window.clearTimeout.bind(window);
  }

  setDevice(device: RelayDevice): void {
    if (this.#disposed) return;
    const previous = this.#device;
    this.#device = device;
    if (previous?.id === device.id && previous.secret === device.secret) return;
    if (previous !== undefined && this.#foreground) {
      void this.#release(previous, this.#tabId);
    }
    if (this.#foreground) this.#startRenewal();
  }

  setForeground(foreground: boolean): void {
    if (this.#disposed || foreground === this.#foreground) return;
    this.#foreground = foreground;
    this.#generation += 1;
    this.#clearHeartbeat();
    const device = this.#device;
    if (foreground) this.#startRenewal();
    else if (device !== undefined) void this.#release(device, this.#tabId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
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
    void this.#renew(device, this.#tabId).finally(() => {
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
