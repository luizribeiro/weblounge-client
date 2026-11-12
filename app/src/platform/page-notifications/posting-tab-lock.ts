export interface PostingTabLocks {
  request(
    name: string,
    options: { readonly steal?: boolean; readonly signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void>;
}

interface LockRequest {
  readonly steal?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Elects the tab that posts page notifications: the most recently foregrounded
 * one, with every other tab queued to inherit the role when it closes.
 */
export class PostingTabLock {
  readonly #name: string;
  #locks: PostingTabLocks | undefined;
  #holder: LockRequest | undefined;
  #release: (() => void) | undefined;
  #queued: AbortController | undefined;
  #claiming = false;
  #disposed = false;

  constructor(name: string, locks: PostingTabLocks | null | undefined) {
    this.#name = name;
    this.#locks = locks ?? undefined;
    this.#queue();
  }

  get held(): boolean {
    return this.#locks === undefined || this.#holder !== undefined;
  }

  claim(): void {
    if (this.#disposed || this.held || this.#claiming) return;
    this.#claiming = true;
    this.#queued?.abort();
    this.#queued = undefined;
    this.#request({ steal: true });
  }

  dispose(): void {
    this.#disposed = true;
    this.#queued?.abort();
    this.#release?.();
  }

  #queue(): void {
    if (this.#disposed || this.#locks === undefined) return;
    if (this.#queued !== undefined || this.#holder !== undefined) return;
    const queued = new AbortController();
    this.#queued = queued;
    this.#request({ signal: queued.signal });
  }

  #request(request: LockRequest): void {
    void this.#locks
      ?.request(this.#name, request, () => this.#hold(request))
      .then(
        () => true,
        (error: unknown) => {
          if (isAbort(error)) return true;
          this.#locks = undefined;
          return false;
        },
      )
      .then((released) => {
        if (request.steal === true) this.#claiming = false;
        if (this.#holder === request) {
          this.#holder = undefined;
          this.#release = undefined;
        }
        if (released && request.signal?.aborted !== true) this.#queue();
      });
  }

  async #hold(request: LockRequest): Promise<void> {
    if (request.signal !== undefined) this.#queued = undefined;
    if (request.steal === true) this.#claiming = false;
    if (this.#disposed) return;
    this.#holder = request;
    await new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
