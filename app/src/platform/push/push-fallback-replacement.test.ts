import { afterEach, describe, expect, it, vi } from "vitest";
import { PushDeliveryCoordinator } from "./push-delivery-coordinator";
import { replaceDeadlineFallback } from "./push-fallback-replacement";
import {
  deadlineFallbackNotification,
  genericNotification,
  type NotificationPresentation,
} from "./push-notification";

describe("push fallback replacement", () => {
  afterEach(() => vi.useRealTimers());

  it("settles after a dismissed fallback and leaves later presentation live", async () => {
    const notifications: NotificationPresentation[] = [];
    const present = async (presentation: NotificationPresentation) => {
      const tag = presentation.options.tag;
      if (tag !== undefined) {
        const existing = notifications.findIndex(
          (notification) => notification.options.tag === tag,
        );
        if (existing >= 0) notifications.splice(existing, 1);
      }
      notifications.push(presentation);
    };
    const fallback = deadlineFallbackNotification(
      genericNotification("Lounge", "first"),
      "first",
    );
    const detail = detailedNotification("Lounge/#first", "first message");

    await present(fallback);
    notifications.splice(0, 1);
    await expect(
      replaceDeadlineFallback(fallback, detail, present),
    ).resolves.toBe(true);

    expect(notifications).toEqual([
      expect.objectContaining({
        title: "first message",
        options: expect.objectContaining({
          tag: "weblounge-fallback/first",
          data: expect.objectContaining({ fallbackId: "first" }),
        }),
      }),
    ]);

    await present(detailedNotification("Lounge/#second", "second message"));
    expect(notifications.map(({ title }) => title)).toEqual([
      "first message",
      "second message",
    ]);
  });

  it("releases the commit chain after a deadline fallback is dismissed", async () => {
    vi.useFakeTimers();
    const preparation = deferred<void>();
    const notifications: NotificationPresentation[] = [];
    const commits: string[] = [];
    let receipt = 0;
    const present = async (presentation: NotificationPresentation) => {
      const tag = presentation.options.tag;
      const existing = notifications.findIndex(
        (notification) => tag !== undefined && notification.options.tag === tag,
      );
      if (existing >= 0) notifications.splice(existing, 1);
      notifications.push(presentation);
    };
    const coordinator = new PushDeliveryCoordinator<
      string,
      NotificationPresentation,
      string
    >({
      fallbackDeadlineMs: 1_500,
      presentationBudgetMs: 2_000,
      generic: () => {
        receipt += 1;
        return deadlineFallbackNotification(
          genericNotification("Lounge", String(receipt)),
          String(receipt),
        );
      },
      finalFallback: (fallback) => fallback,
      fallbackCommit: () => "fallback",
      prepare: async (id) => {
        if (id === "first") await preparation.promise;
        return {
          kind: "visible",
          presentation: detailedNotification(`Lounge/#${id}`, `${id} message`),
          commit: id,
        };
      },
      present,
      replace: (fallback, replacement) =>
        replaceDeadlineFallback(fallback, replacement, present),
      commit: async (commit) => {
        commits.push(commit);
      },
      reportError: () => undefined,
      retryPrepare: () => false,
    });

    const first = coordinator.enqueue("first");
    await vi.advanceTimersByTimeAsync(1_500);
    notifications.splice(0, 1);
    preparation.resolve();
    await first;

    expect(notifications.map(({ title }) => title)).toEqual(["first message"]);
    await coordinator.enqueue("second");
    expect(notifications.map(({ title }) => title)).toEqual([
      "first message",
      "second message",
    ]);
    expect(commits).toEqual(["first", "second"]);
  });
});

function detailedNotification(
  tag: string,
  title: string,
): NotificationPresentation {
  return {
    title,
    options: {
      tag,
      data: { route: `/${title.replace(" ", "-")}`, conversationTag: tag },
    },
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
