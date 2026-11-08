import { randomUUID } from "node:crypto";
import type { BrowserContext, CDPSession, Page } from "@playwright/test";

const deliveryIdField = "_webloungeTestDeliveryId";
const completionStateKey = "webloungePushDeliveryCompletions";

// CDP acknowledges injection before the push event's waitUntil work settles.
export async function deliverPush(
  context: BrowserContext,
  page: Page,
  data: string,
): Promise<void> {
  await deliverPushes(context, page, [data]);
}

export async function deliverPushes(
  context: BrowserContext,
  page: Page,
  data: readonly string[],
): Promise<void> {
  const deliveries = data.map((payload) => {
    const id = randomUUID();
    return { id, payload: withDeliveryId(payload, id) };
  });
  await installCompletionListener(page);
  const { registrationId, session } = await pushDeliveryTarget(context, page);
  await Promise.all(
    deliveries.map(({ payload }) =>
      session.send("ServiceWorker.deliverPushMessage", {
        origin: new URL(page.url()).origin,
        registrationId,
        data: payload,
      }),
    ),
  );
  const errors = await waitForCompletions(
    page,
    deliveries.map(({ id }) => id),
  );
  const error = errors.find((candidate) => candidate !== null);
  if (error !== undefined && error !== null) {
    throw new Error(`push delivery failed: ${error}`);
  }
}

function withDeliveryId(payload: string, id: string): string {
  const envelope: unknown = JSON.parse(payload);
  if (typeof envelope !== "object" || envelope === null) {
    throw new Error("push fixture envelope is invalid");
  }
  return JSON.stringify({ ...envelope, [deliveryIdField]: id });
}

async function installCompletionListener(page: Page): Promise<void> {
  await page.evaluate((key) => {
    if (Reflect.has(globalThis, key)) return;
    interface CompletionState {
      readonly results: Map<string, string | null>;
      readonly waiters: Map<string, (error: string | null) => void>;
    }
    const state: CompletionState = {
      results: new Map(),
      waiters: new Map(),
    };
    Reflect.set(globalThis, key, state);
    navigator.serviceWorker.addEventListener("message", (event) => {
      const message: unknown = event.data;
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "push_delivery_complete" ||
        !("id" in message) ||
        typeof message.id !== "string"
      ) {
        return;
      }
      const error =
        "error" in message && typeof message.error === "string"
          ? message.error
          : null;
      const waiter = state.waiters.get(message.id);
      if (waiter === undefined) state.results.set(message.id, error);
      else waiter(error);
    });
  }, completionStateKey);
}

async function waitForCompletions(
  page: Page,
  ids: readonly string[],
): Promise<readonly (string | null)[]> {
  return page.evaluate(
    async ({ key, pendingIds }) => {
      interface CompletionState {
        readonly results: Map<string, string | null>;
        readonly waiters: Map<string, (error: string | null) => void>;
      }
      const state = Reflect.get(globalThis, key) as CompletionState | undefined;
      if (state === undefined)
        throw new Error("push completion state is absent");
      const results = await Promise.all(
        pendingIds.map((id) => {
          if (state.results.has(id)) return state.results.get(id) ?? null;
          return new Promise<string | null>((resolve) => {
            state.waiters.set(id, resolve);
          });
        }),
      );
      for (const id of pendingIds) {
        state.results.delete(id);
        state.waiters.delete(id);
      }
      return results;
    },
    { key: completionStateKey, pendingIds: ids },
  );
}

const pushDeliveryTargets = new WeakMap<
  Page,
  Promise<{ readonly registrationId: string; readonly session: CDPSession }>
>();

function pushDeliveryTarget(
  context: BrowserContext,
  page: Page,
): Promise<{ readonly registrationId: string; readonly session: CDPSession }> {
  const existing = pushDeliveryTargets.get(page);
  if (existing !== undefined) return existing;
  const created = createPushDeliveryTarget(context, page);
  pushDeliveryTargets.set(page, created);
  return created;
}

async function createPushDeliveryTarget(
  context: BrowserContext,
  page: Page,
): Promise<{ readonly registrationId: string; readonly session: CDPSession }> {
  const session = await context.newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  const registrationId = new Promise<string>((resolve) => {
    session.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      const current = versions.find(
        (candidate) =>
          candidate.status === "activated" &&
          candidate.controlledClients.includes(targetInfo.targetId),
      );
      if (current !== undefined) resolve(current.registrationId);
    });
  });
  await session.send("ServiceWorker.enable");
  return { registrationId: await registrationId, session };
}
