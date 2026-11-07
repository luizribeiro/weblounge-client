type ReleaseOwner = () => void;

interface LockProvider {
  request(
    name: string,
    options: { readonly mode: "exclusive" },
    callback: () => Promise<void>,
  ): Promise<void>;
}

export class PushSyncOwner {
  readonly #acquire: () => Promise<ReleaseOwner>;
  #releaseLock: (() => void) | undefined;
  #releaseOwner: ReleaseOwner | undefined;
  #disposed = false;

  constructor(
    name: string,
    acquire: () => Promise<ReleaseOwner>,
    locks: LockProvider | undefined = navigator.locks,
  ) {
    this.#acquire = acquire;
    if (locks === undefined) {
      void this.#holdWithoutLock();
      return;
    }
    void locks
      .request(name, { mode: "exclusive" }, () => this.#holdLock())
      .catch(() => undefined);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#releaseLock?.();
    if (this.#releaseLock === undefined) this.#releaseOwner?.();
  }

  async #holdWithoutLock(): Promise<void> {
    if (this.#disposed) return;
    const releaseOwner = await this.#acquire();
    if (this.#disposed) releaseOwner();
    else this.#releaseOwner = releaseOwner;
  }

  async #holdLock(): Promise<void> {
    if (this.#disposed) return;
    const releaseOwner = await this.#acquire();
    if (this.#disposed) {
      releaseOwner();
      return;
    }
    this.#releaseOwner = releaseOwner;
    await new Promise<void>((resolve) => {
      this.#releaseLock = resolve;
    });
    this.#releaseLock = undefined;
    releaseOwner();
    this.#releaseOwner = undefined;
  }
}
