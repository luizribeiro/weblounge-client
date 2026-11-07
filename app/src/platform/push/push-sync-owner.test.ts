import { expect, it, vi } from "vitest";
import { PushSyncOwner } from "./push-sync-owner";

it("keeps one owner and transfers ownership after disposal", async () => {
  const locks = new TestLocks();
  const active = new Set<string>();
  const maximumOwners = vi.fn(() => active.size);
  const acquire = (name: string) => async () => {
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

class TestLocks {
  readonly #queues = new Map<string, Array<() => Promise<void>>>();
  readonly #active = new Set<string>();

  request(
    name: string,
    _options: { readonly mode: "exclusive" },
    callback: () => Promise<void>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const run = async () => {
        try {
          await callback();
          resolve();
        } catch (error: unknown) {
          reject(error);
        } finally {
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

  #drain(name: string): void {
    if (this.#active.has(name)) return;
    const next = this.#queues.get(name)?.shift();
    if (next === undefined) return;
    this.#active.add(name);
    void next();
  }
}
