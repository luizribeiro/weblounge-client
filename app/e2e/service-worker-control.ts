import type { Page } from "@playwright/test";

/**
 * Resolves once the registration has no install in flight and its activated
 * worker controls the page. Install precaches the whole shell, so how long it
 * takes depends on machine load; the wait follows lifecycle events and is
 * bounded only by the test's own budget.
 */
export async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const container = navigator.serviceWorker;
    const registration = await container.ready;
    const settled = () =>
      registration.installing === null &&
      registration.waiting === null &&
      registration.active?.state === "activated" &&
      container.controller === registration.active;
    const lifecycleChange = () =>
      new Promise<void>((resolve) => {
        const listening = new AbortController();
        const options = { once: true, signal: listening.signal };
        const changed = () => {
          listening.abort();
          resolve();
        };
        for (const worker of [
          registration.installing,
          registration.waiting,
          registration.active,
        ])
          worker?.addEventListener("statechange", changed, options);
        registration.addEventListener("updatefound", changed, options);
        container.addEventListener("controllerchange", changed, options);
      });
    while (!settled()) {
      await lifecycleChange();
      if (registration.active === null && registration.installing === null)
        throw new Error("the service worker install failed");
    }
  });
}
