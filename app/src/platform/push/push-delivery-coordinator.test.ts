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
  readonly kind: "visible" | "markread" | "fallback";
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
    const messagePresented = deferred<void>();
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
        if (presentation === "message") messagePresented.resolve();
      },
      commit: async (commit) => {
        if (commit.id === "message") await releaseFirst.promise;
        commits.push(commit.id);
      },
    });

    const message = coordinator.enqueue({ id: "message", kind: "visible" });
    const markread = coordinator.enqueue({ id: "read", kind: "markread" });
    await Promise.all([markreadPrepared.promise, messagePresented.promise]);

    expect(presentations).toEqual(["message"]);
    expect(commits).toEqual([]);

    releaseFirst.resolve();
    await Promise.all([message, markread]);
    expect(commits).toEqual(["message", "read"]);
  });

  it("does not release a failed preparation past an earlier commit", async () => {
    const releaseFirst = deferred<void>();
    const fallbackPresented = deferred<void>();
    const readPrepared = deferred<void>();
    const commits: string[] = [];
    const coordinator = createCoordinator({
      prepare: async (input) => {
        if (input.id === "missing") throw new Error("missing route");
        if (input.kind === "markread") {
          readPrepared.resolve();
          return { kind: "silent", commit: input };
        }
        return visible(input.id);
      },
      present: async (presentation) => {
        if (presentation === "generic") fallbackPresented.resolve();
      },
      commit: async (commit) => {
        if (commit.id === "first") await releaseFirst.promise;
        commits.push(commit.id);
      },
    });

    const first = coordinator.enqueue({ id: "first", kind: "visible" });
    const missing = coordinator.enqueue({ id: "missing", kind: "visible" });
    const markread = coordinator.enqueue({ id: "read", kind: "markread" });
    await Promise.all([fallbackPresented.promise, readPrepared.promise]);
    expect(commits).toEqual([]);

    releaseFirst.resolve();
    await Promise.all([first, missing, markread]);
    expect(commits).toEqual(["first", "fallback", "read"]);
  });

  it("retries a transient prepare failure before classifying a control", async () => {
    let attempts = 0;
    const presentations: string[] = [];
    const commits: string[] = [];
    const coordinator = createCoordinator({
      prepare: async (input) => {
        attempts += 1;
        if (attempts === 1) throw new RetryableTestError();
        return { kind: "silent", commit: input };
      },
      present: async (presentation) => {
        presentations.push(presentation);
      },
      commit: async (commit) => {
        commits.push(commit.id);
      },
      retryPrepare: (error) => error instanceof RetryableTestError,
    });

    await coordinator.enqueue({ id: "read", kind: "markread" });
    expect(attempts).toBe(2);
    expect(presentations).toEqual([]);
    expect(commits).toEqual(["read"]);
  });

  it("presents the generic fallback while route storage is blocked", async () => {
    vi.useFakeTimers();
    try {
      const releasePrepare = deferred<void>();
      const presentations: string[] = [];
      const coordinator = new PushDeliveryCoordinator<Input, string, Commit>({
        fallbackDeadlineMs: 1_500,
        presentationBudgetMs: 2_000,
        generic: () => "generic",
        finalFallback: (generic: string) => generic,
        fallbackCommit: () => ({ id: "fallback", kind: "fallback" }),
        prepare: async (input) => {
          await releasePrepare.promise;
          return visible(input.id);
        },
        present: async (presentation) => {
          presentations.push(presentation);
        },
        replace: async () => false,
        commit: async () => undefined,
        reportError: () => undefined,
        retryPrepare: () => false,
      });

      const delivery = coordinator.enqueue({ id: "slow", kind: "visible" });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(presentations).toEqual(["generic"]);

      releasePrepare.resolve();
      await delivery;
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a fallback when preparation finishes after its deadline", async () => {
    vi.useFakeTimers();
    try {
      const releasePrepare = deferred<void>();
      const notifications: string[] = [];
      const present = async (presentation: string) => {
        notifications.push(presentation);
      };
      const dependencies = {
        fallbackDeadlineMs: 1_500,
        presentationBudgetMs: 2_000,
        generic: () => "generic",
        finalFallback: (generic: string) => generic,
        fallbackCommit: () => ({ id: "fallback", kind: "fallback" }) as Commit,
        prepare: async (input: Input) => {
          await releasePrepare.promise;
          return visible(input.id);
        },
        present,
        replace: async (fallback: string, presentation: string) => {
          await present(presentation);
          const fallbackIndex = notifications.indexOf(fallback);
          if (fallbackIndex >= 0) notifications.splice(fallbackIndex, 1);
          return true;
        },
        commit: async () => undefined,
        reportError: () => undefined,
        retryPrepare: () => false,
      };
      const coordinator = new PushDeliveryCoordinator<Input, string, Commit>(
        dependencies,
      );

      const delivery = coordinator.enqueue({ id: "message", kind: "visible" });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(notifications).toEqual(["generic"]);

      releasePrepare.resolve();
      await delivery;

      expect(notifications).toEqual(["message"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off while retrying a failed deadline presentation", async () => {
    vi.useFakeTimers();
    try {
      const releasePrepare = deferred<void>();
      let attempts = 0;
      const coordinator = new PushDeliveryCoordinator<Input, string, Commit>({
        fallbackDeadlineMs: 1_500,
        presentationBudgetMs: 2_000,
        generic: () => "generic",
        finalFallback: (generic) => generic,
        fallbackCommit: () => ({ id: "fallback", kind: "fallback" }),
        prepare: async (input) => {
          await releasePrepare.promise;
          return visible(input.id);
        },
        present: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("presentation unavailable");
        },
        replace: async () => false,
        commit: async () => undefined,
        reportError: () => undefined,
        retryPrepare: () => false,
      });

      const delivery = coordinator.enqueue({ id: "slow", kind: "visible" });
      await vi.advanceTimersByTimeAsync(1_650);
      expect(attempts).toBe(3);

      releasePrepare.resolve();
      await delivery;
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles permanent presentation failure and releases later commits", async () => {
    vi.useFakeTimers();
    try {
      const commits: string[] = [];
      const errors: unknown[] = [];
      let attempts = 0;
      const coordinator = new PushDeliveryCoordinator<Input, string, Commit>({
        fallbackDeadlineMs: 200,
        presentationBudgetMs: 500,
        generic: () => "generic",
        finalFallback: (generic) => generic,
        fallbackCommit: () => ({ id: "fallback", kind: "fallback" }),
        prepare: async (input) =>
          input.kind === "markread"
            ? { kind: "silent", commit: input }
            : visible(input.id),
        present: async () => {
          attempts += 1;
          throw new Error("presentation unavailable");
        },
        replace: async () => false,
        commit: async (commit) => {
          commits.push(commit.id);
        },
        reportError: (error) => errors.push(error),
        retryPrepare: () => false,
      });

      const failed = coordinator.enqueue({ id: "failed", kind: "visible" });
      const markread = coordinator.enqueue({ id: "read", kind: "markread" });
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([failed, markread]);

      expect(attempts).toBeGreaterThan(1);
      expect(errors).toHaveLength(1);
      expect(commits).toEqual(["read"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an immediate preparation failure out of deadline replacement", async () => {
    vi.useFakeTimers();
    try {
      const failPreparation = deferred<void>();
      const presentations: string[] = [];
      const coordinator = new PushDeliveryCoordinator<Input, string, Commit>({
        fallbackDeadlineMs: 1_500,
        presentationBudgetMs: 2_000,
        generic: () => "replaceable generic",
        finalFallback: () => "final generic",
        fallbackCommit: () => ({ id: "fallback", kind: "fallback" }),
        prepare: async () => {
          await failPreparation.promise;
          throw new Error("invalid route keys");
        },
        present: async (presentation) => {
          presentations.push(presentation);
        },
        replace: async () => false,
        commit: async () => undefined,
        reportError: () => undefined,
        retryPrepare: () => false,
      });

      const delivery = coordinator.enqueue({ id: "missing", kind: "visible" });
      await vi.advanceTimersByTimeAsync(1_499);
      failPreparation.resolve();
      await delivery;

      expect(presentations).toEqual(["final generic"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a commit failure without presenting or committing a fallback", async () => {
    const presentations: string[] = [];
    const commits: string[] = [];
    const errors: unknown[] = [];
    const coordinator = createCoordinator({
      prepare: async (input) =>
        input.kind === "markread"
          ? { kind: "silent", commit: input }
          : visible(input.id),
      present: async (presentation) => {
        presentations.push(presentation);
      },
      commit: async (commit) => {
        commits.push(commit.id);
        if (commit.id === "read") throw new Error("commit failed");
      },
      reportError: (error) => errors.push(error),
    });

    await coordinator.enqueue({ id: "read", kind: "markread" });

    expect(presentations).toEqual([]);
    expect(commits).toEqual(["read"]);
    expect(errors).toHaveLength(1);
  });

  it("does not re-present a visible push after its commit fails", async () => {
    const presentations: string[] = [];
    const commits: string[] = [];
    const errors: unknown[] = [];
    const coordinator = createCoordinator({
      prepare: async (input) => visible(input.id),
      present: async (presentation) => {
        presentations.push(presentation);
      },
      commit: async (commit) => {
        commits.push(commit.id);
        throw new Error("commit failed");
      },
      reportError: (error) => errors.push(error),
    });

    await coordinator.enqueue({ id: "message", kind: "visible" });

    expect(presentations).toEqual(["message"]);
    expect(commits).toEqual(["message"]);
    expect(errors).toHaveLength(1);
  });
});

function createCoordinator(overrides: {
  readonly prepare: (
    input: Input,
  ) => Promise<PreparedPushDelivery<string, Commit>>;
  readonly present: (presentation: string) => Promise<void>;
  readonly commit: (commit: Commit) => Promise<void>;
  readonly reportError?: (error: unknown) => void;
  readonly retryPrepare?: (error: unknown) => boolean;
}): PushDeliveryCoordinator<Input, string, Commit> {
  return new PushDeliveryCoordinator({
    fallbackDeadlineMs: 59_500,
    presentationBudgetMs: 60_000,
    generic: () => "generic",
    finalFallback: (generic) => generic,
    fallbackCommit: () => ({ id: "fallback", kind: "fallback" }),
    replace: async () => false,
    reportError: () => undefined,
    retryPrepare: () => false,
    ...overrides,
  });
}

class RetryableTestError extends Error {}

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
