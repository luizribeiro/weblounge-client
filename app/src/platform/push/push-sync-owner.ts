type ReleaseOwner = () => void;

interface LockProvider {
  request(
    name: string,
    options: { readonly mode: "exclusive" },
    callback: () => Promise<void>,
  ): Promise<void>;
}

export class PushSyncOwner {
  readonly #name: string;
  readonly #acquire: () => ReleaseOwner;
  readonly #locks: LockProvider | undefined;
  #releaseLock: (() => void) | undefined;
  #releaseOwner: ReleaseOwner | undefined;
  #eligible = true;
  #requesting = false;
  #disposed = false;

  constructor(
    name: string,
    acquire: () => ReleaseOwner,
    locks: LockProvider | null | undefined = navigator.locks,
    eligible = true,
  ) {
    this.#name = name;
    this.#acquire = acquire;
    this.#locks = locks ?? undefined;
    this.#eligible = eligible;
    this.#requestOwnership();
  }

  get owned(): boolean {
    return this.#releaseOwner !== undefined;
  }

  setEligible(eligible: boolean): void {
    if (this.#disposed || eligible === this.#eligible) return;
    this.#eligible = eligible;
    if (!eligible) {
      this.#releaseLock?.();
      if (this.#releaseLock === undefined) this.#releaseWithoutLock();
      return;
    }
    this.#requestOwnership();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#eligible = false;
    this.#releaseLock?.();
    if (this.#releaseLock === undefined) this.#releaseWithoutLock();
  }

  #requestOwnership(): void {
    if (this.#disposed || !this.#eligible || this.#requesting || this.owned) {
      return;
    }
    if (this.#locks === undefined) {
      this.#acquireWithoutLock();
      return;
    }
    this.#requesting = true;
    void this.#locks
      .request(this.#name, { mode: "exclusive" }, () => this.#holdLock())
      .catch(() => undefined)
      .finally(() => {
        this.#requesting = false;
        if (!this.#disposed && this.#eligible && !this.owned) {
          queueMicrotask(() => this.#requestOwnership());
        }
      });
  }

  async #holdLock(): Promise<void> {
    if (this.#disposed || !this.#eligible) return;
    const releaseOwner = this.#acquire();
    if (this.#disposed || !this.#eligible) return releaseOwner();
    this.#releaseOwner = releaseOwner;
    try {
      await new Promise<void>((resolve) => {
        this.#releaseLock = resolve;
      });
    } finally {
      this.#releaseLock = undefined;
      releaseOwner();
      this.#releaseOwner = undefined;
    }
  }

  #acquireWithoutLock(): void {
    this.#requesting = true;
    try {
      const releaseOwner = this.#acquire();
      if (this.#disposed || !this.#eligible) releaseOwner();
      else this.#releaseOwner = releaseOwner;
    } catch {
      queueMicrotask(() => this.#requestOwnership());
    } finally {
      this.#requesting = false;
    }
  }

  #releaseWithoutLock(): void {
    this.#releaseOwner?.();
    this.#releaseOwner = undefined;
  }
}
