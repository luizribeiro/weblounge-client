import { expect, it, vi } from "vitest";
import { PushSyncOwner } from "./push-sync-owner";

it("keeps one owner and transfers ownership after disposal", async () => {
  const locks = new TestLocks();
  const active = new Set<string>();
  const maximumOwners = vi.fn(() => active.size);
  const acquire = (name: string) => () => {
    active.add(name);
    maximumOwners();
    return () => active.delete(name);
  };
  const first = new PushSyncOwner("push", acquire("first"), locks);
  const second = new PushSyncOwner("push", acquire("second"), locks);

  await vi.waitFor(() => expect(active).toEqual(new Set(["first"])));
  first.dispose();
  await vi.waitFor(() => expect(active).toEqual(new Set(["second"])));
  second.dispose();
  await vi.waitFor(() => expect(active).toEqual(new Set()));
  expect(maximumOwners.mock.results.every(({ value }) => value === 1)).toBe(
    true,
  );
});

it("reads current state when a waiting tab takes ownership", async () => {
  const locks = new TestLocks();
  let target = "startup-target";
  const acquiredTargets: string[] = [];
  const first = new PushSyncOwner("push", () => () => {}, locks);
  const second = new PushSyncOwner(
    "push",
    () => {
      acquiredTargets.push(target);
      return () => {};
    },
    locks,
  );

  await vi.waitFor(() => expect(first.owned).toBe(true));
  target = "rotated-target";
  first.dispose();
  await vi.waitFor(() => expect(second.owned).toBe(true));

  expect(acquiredTargets).toEqual(["rotated-target"]);
  second.dispose();
});

it("does not acquire after disposal while waiting for the lock", async () => {
  const locks = new TestLocks();
  const first = new PushSyncOwner("push", () => () => {}, locks);
  const acquire = vi.fn(() => () => {});
  const second = new PushSyncOwner("push", acquire, locks);

  second.dispose();
  first.dispose();
  await vi.waitFor(() => expect(locks.pending("push")).toBe(0));

  expect(acquire).not.toHaveBeenCalled();
});

it("runs without Web Locks", async () => {
  const release = vi.fn();
  const owner = new PushSyncOwner("push", () => release, null);

  await vi.waitFor(() => expect(owner.owned).toBe(true));
  owner.dispose();

  expect(release).toHaveBeenCalledOnce();
});

it("transfers ownership after the owning context crashes", async () => {
  const locks = new TestLocks();
  const first = new PushSyncOwner("push", () => () => {}, locks);
  const second = new PushSyncOwner("push", () => () => {}, locks);

  await vi.waitFor(() => expect(first.owned).toBe(true));
  locks.crash("push");
  await vi.waitFor(() => expect(second.owned).toBe(true));

  second.dispose();
});

it("relinquishes on suspension and reacquires on resume", async () => {
  const locks = new TestLocks();
  const releases: ReturnType<typeof vi.fn>[] = [];
  const owner = new PushSyncOwner(
    "push",
    () => {
      const release = vi.fn();
      releases.push(release);
      return release;
    },
    locks,
  );

  await vi.waitFor(() => expect(owner.owned).toBe(true));
  owner.setEligible(false);
  await vi.waitFor(() => expect(owner.owned).toBe(false));
  expect(releases[0]).toHaveBeenCalledOnce();

  owner.setEligible(true);
  await vi.waitFor(() => expect(releases).toHaveLength(2));
  owner.dispose();
});

it("tries again when acquiring ownership throws", async () => {
  const acquire = vi
    .fn<() => () => void>()
    .mockImplementationOnce(() => {
      throw new Error("startup failed");
    })
    .mockImplementation(() => () => {});
  const owner = new PushSyncOwner("push", acquire, new TestLocks());

  await vi.waitFor(() => expect(owner.owned).toBe(true));

  expect(acquire).toHaveBeenCalledTimes(2);
  owner.dispose();
});

class TestLocks {
  readonly #queues = new Map<string, Array<() => Promise<void>>>();
  readonly #active = new Set<string>();
  readonly #crashes = new Map<string, () => void>();

  request(
    name: string,
    _options: { readonly mode: "exclusive" },
    callback: () => Promise<void>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const run = async () => {
        let crash = () => {};
        const crashed = new Promise<void>((resolveCrash) => {
          crash = resolveCrash;
        });
        this.#crashes.set(name, crash);
        try {
          await Promise.race([callback(), crashed]);
          resolve();
        } catch (error: unknown) {
          reject(error);
        } finally {
          if (this.#crashes.get(name) === crash) this.#crashes.delete(name);
          this.#active.delete(name);
          this.#drain(name);
        }
      };
      const queue = this.#queues.get(name) ?? [];
      queue.push(run);
      this.#queues.set(name, queue);
      this.#drain(name);
    });
  }

  pending(name: string): number {
    return this.#queues.get(name)?.length ?? 0;
  }

  crash(name: string): void {
    this.#crashes.get(name)?.();
  }

  #drain(name: string): void {
    if (this.#active.has(name)) return;
    const next = this.#queues.get(name)?.shift();
    if (next === undefined) return;
    this.#active.add(name);
    void next();
  }
}
