export type ServiceWorkerUpdateListener = () => void;

let updateReady = false;
const updateListeners = new Set<ServiceWorkerUpdateListener>();

export function serviceWorkerUpdateIsReady(): boolean {
  return updateReady;
}

export function onServiceWorkerUpdateReady(
  listener: ServiceWorkerUpdateListener,
): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

export function registerProductionServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const register = () => scheduleRegistration(navigator.serviceWorker);
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

function scheduleRegistration(container: ServiceWorkerContainer): void {
  requestAnimationFrame(() => {
    if (window.requestIdleCallback === undefined) {
      void registerAfterLoad(container);
      return;
    }
    window.requestIdleCallback(() => void registerAfterLoad(container));
  });
}

async function registerAfterLoad(container: ServiceWorkerContainer) {
  try {
    const registration = await container.register("/service-worker.js", {
      scope: "/",
      updateViaCache: "none",
    });
    if (registration.waiting !== null) announceUpdate();
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed" && container.controller !== null) {
          announceUpdate();
        }
      });
    });
  } catch {
    // An online page remains usable when private browsing or policy rejects registration.
  }
}

function announceUpdate(): void {
  if (updateReady) return;
  updateReady = true;
  for (const listener of updateListeners) listener();
}
