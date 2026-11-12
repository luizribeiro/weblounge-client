import { describe, expect, it, vi } from "vitest";
import { PostingTabLock, type PostingTabLocks } from "./posting-tab-lock";

interface Grant {
  readonly callback: () => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

class FakeLockManager implements PostingTabLocks {
  #holder: Grant | undefined;
  readonly #waiting: Grant[] = [];

  request(
    _name: string,
    options: { readonly steal?: boolean; readonly signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const grant = { callback, resolve, reject };
      if (options.steal === true) {
        const stolen = this.#holder;
        this.#holder = undefined;
        stolen?.reject(new DOMException("stolen", "AbortError"));
        this.#grant(grant);
        return;
      }
      options.signal?.addEventListener("abort", () => {
        const index = this.#waiting.indexOf(grant);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(new DOMException("aborted", "AbortError"));
      });
      if (this.#holder === undefined) this.#grant(grant);
      else this.#waiting.push(grant);
    });
  }

  #grant(grant: Grant): void {
    this.#holder = grant;
    void grant.callback().then(() => {
      if (this.#holder !== grant) return;
      this.#holder = undefined;
      grant.resolve();
      const next = this.#waiting.shift();
      if (next !== undefined) this.#grant(next);
    });
  }
}

describe("PostingTabLock", () => {
  it("lets the only tab post", async () => {
    const tab = new PostingTabLock("page-notifier", new FakeLockManager());

    await vi.waitFor(() => expect(tab.held).toBe(true));
  });

  it("posts from every tab when the platform has no Web Locks", () => {
    expect(new PostingTabLock("page-notifier", undefined).held).toBe(true);
  });

  it("moves posting to the tab the user foregrounds last", async () => {
    const locks = new FakeLockManager();
    const first = new PostingTabLock("page-notifier", locks);
    const second = new PostingTabLock("page-notifier", locks);
    await vi.waitFor(() => expect(first.held).toBe(true));
    expect(second.held).toBe(false);

    second.claim();

    await vi.waitFor(() =>
      expect([first.held, second.held]).toEqual([false, true]),
    );

    first.claim();

    await vi.waitFor(() =>
      expect([first.held, second.held]).toEqual([true, false]),
    );
  });

  it("hands posting to a waiting tab when the posting tab closes", async () => {
    const locks = new FakeLockManager();
    const first = new PostingTabLock("page-notifier", locks);
    const second = new PostingTabLock("page-notifier", locks);
    await vi.waitFor(() => expect(first.held).toBe(true));

    first.dispose();

    await vi.waitFor(() => expect(second.held).toBe(true));
  });

  it("keeps a tab that was stolen from queued to inherit posting again", async () => {
    const locks = new FakeLockManager();
    const first = new PostingTabLock("page-notifier", locks);
    const second = new PostingTabLock("page-notifier", locks);
    await vi.waitFor(() => expect(first.held).toBe(true));
    second.claim();
    await vi.waitFor(() =>
      expect([first.held, second.held]).toEqual([false, true]),
    );

    second.dispose();

    await vi.waitFor(() => expect(first.held).toBe(true));
  });

  it("posts without an election when the platform refuses the lock", async () => {
    const request = vi.fn(() =>
      Promise.reject(new DOMException("blocked", "SecurityError")),
    );
    const tab = new PostingTabLock("page-notifier", { request });

    await vi.waitFor(() => expect(tab.held).toBe(true));
    tab.claim();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
