import { describe, expect, it, vi } from "vitest";
import {
  type PreparedPushDelivery,
  PushDeliveryCoordinator,
} from "./push-delivery-coordinator";

interface Input {
  readonly id: string;
  readonly kind: "visible" | "markread";
}

interface Commit {
  readonly id: string;
  readonly kind: "visible" | "markread";
}

describe("push delivery coordination", () => {
  it.each(["prepare", "present", "commit"] as const)(
    "presents a later push while an earlier push is delayed in %s",
    async (delayedStage) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const secondPresented = deferred<void>();
      const presentations: string[] = [];
      const commits: string[] = [];
      const coordinator = createCoordinator({
        prepare: async (input) => {
          if (input.id === "first" && delayedStage === "prepare") {
            entered.resolve();
            await release.promise;
          }
          return visible(input.id);
        },
        present: async (presentation) => {
          if (presentation === "first" && delayedStage === "present") {
            entered.resolve();
            await release.promise;
          }
          presentations.push(presentation);
          if (presentation === "second") secondPresented.resolve();
        },
        commit: async (commit) => {
          if (commit.id === "first" && delayedStage === "commit") {
            entered.resolve();
            await release.promise;
          }
          commits.push(commit.id);
        },
      });

      const first = coordinator.enqueue({ id: "first", kind: "visible" });
      await entered.promise;
      const second = coordinator.enqueue({ id: "second", kind: "visible" });

      await secondPresented.promise;
      expect(presentations).toContain("second");
      expect(commits).not.toContain("second");

      release.resolve();
      await Promise.all([first, second]);
      expect(commits).toEqual(["first", "second"]);
    },
  );

  it("keeps a silent MARKREAD behind every earlier received message", async () => {
    const releaseFirst = deferred<void>();
    const markreadPrepared = deferred<void>();
    const commits: string[] = [];
    const presentations: string[] = [];
    const coordinator = createCoordinator({
      prepare: async (input) => {
        if (input.kind === "markread") {
          markreadPrepared.resolve();
          return { kind: "silent", commit: input };
        }
        return visible(input.id);
      },
      present: async (presentation) => {
        presentations.push(presentation);
      },
      commit: async (commit) => {
        if (commit.id === "message") await releaseFirst.promise;
        commits.push(commit.id);
      },
    });

    const message = coordinator.enqueue({ id: "message", kind: "visible" });
    const markread = coordinator.enqueue({ id: "read", kind: "markread" });
    await markreadPrepared.promise;

    expect(presentations).toEqual(["message"]);
    expect(commits).toEqual([]);

    releaseFirst.resolve();
    await Promise.all([message, markread]);
    expect(commits).toEqual(["message", "read"]);
  });

  it("presents the generic fallback while route storage is blocked", async () => {
    vi.useFakeTimers();
    try {
      const releasePrepare = deferred<void>();
      const presentations: string[] = [];
      const coordinator = new PushDeliveryCoordinator<Input, string, Commit>({
        deadlineMs: 2_000,
        generic: () => "generic",
        prepare: async (input) => {
          await releasePrepare.promise;
          return visible(input.id);
        },
        present: async (presentation) => {
          presentations.push(presentation);
        },
        commit: async () => undefined,
      });

      const delivery = coordinator.enqueue({ id: "slow", kind: "visible" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(presentations).toEqual(["generic"]);

      releasePrepare.resolve();
      await delivery;
    } finally {
      vi.useRealTimers();
    }
  });
});

function createCoordinator(overrides: {
  readonly prepare: (
    input: Input,
  ) => Promise<PreparedPushDelivery<string, Commit>>;
  readonly present: (presentation: string) => Promise<void>;
  readonly commit: (commit: Commit) => Promise<void>;
}): PushDeliveryCoordinator<Input, string, Commit> {
  return new PushDeliveryCoordinator({
    deadlineMs: 60_000,
    generic: () => "generic",
    ...overrides,
  });
}

function visible(id: string): PreparedPushDelivery<string, Commit> {
  return {
    kind: "visible",
    presentation: id,
    commit: { id, kind: "visible" },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T) => void;
} {
  let resolve: (value?: T) => void = () => {};
  const promise = new Promise<T>((fulfill) => {
    resolve = (value) => fulfill(value as T);
  });
  return { promise, resolve };
}
