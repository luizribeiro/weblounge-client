import type { Page } from "@playwright/test";

export async function trackDedicatedEngine(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
    const NativeWorker = Worker;
    class TrackedWorker extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        Reflect.set(globalThis, "trackedEngineWorker", this);
      }
    }
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: TrackedWorker,
    });
  });
}

export async function notificationPromptDismissed(
  page: Page,
): Promise<boolean> {
  const loaded = await sendEngineRequest(
    page,
    { type: "load_notification_prompt_dismissal" },
    "notification_prompt_dismissal_loaded",
  );
  if (typeof loaded.dismissed !== "boolean")
    throw new Error("notification prompt dismissal is not a boolean");
  return loaded.dismissed;
}

export async function dismissNotificationPrompt(page: Page): Promise<void> {
  await sendEngineRequest(
    page,
    { type: "dismiss_notification_prompt" },
    "command_result",
  );
}

// Uses the page's own engine port, so replies take the worker routing the app
// relies on.
function sendEngineRequest(
  page: Page,
  request: Record<string, unknown>,
  replyType: string,
): Promise<Record<string, unknown>> {
  return page.evaluate(
    ({ request, replyType }) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const worker = Reflect.get(globalThis, "trackedEngineWorker");
        if (!(worker instanceof Worker)) {
          reject(new Error("dedicated engine worker is unavailable"));
          return;
        }
        const id = crypto.randomUUID();
        const onMessage = (event: MessageEvent<unknown>) => {
          const message = event.data;
          if (typeof message !== "object" || message === null) return;
          const reply: Record<string, unknown> = { ...message };
          if (reply.id !== id && reply.command_id !== id) return;
          if (reply.type === replyType) {
            worker.removeEventListener("message", onMessage);
            resolve(reply);
          } else if (
            reply.type === "command_result" ||
            reply.type === "command_rejected"
          ) {
            worker.removeEventListener("message", onMessage);
            reject(
              new Error(
                `${request.type} ended without ${replyType}: ${reply.type}`,
              ),
            );
          }
        };
        worker.addEventListener("message", onMessage);
        worker.postMessage({ type: "request", payload: { id, request } });
      }),
    { request, replyType },
  );
}
