export type ServiceWorkerUpdateListener = () => void;

let updateReady = false;
const updateListeners = new Set<ServiceWorkerUpdateListener>();

interface ControllerContainer {
  readonly controller: ServiceWorker | null;
  addEventListener(type: "controllerchange", listener: () => void): void;
  removeEventListener(type: "controllerchange", listener: () => void): void;
}

interface ReloadDocument {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
  querySelector(selectors: string): Element | null;
}

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
  const container = navigator.serviceWorker;
  if (container.controller !== null) return;
  const register = () => scheduleRegistration(container);
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

export function checkForProductionServiceWorkerUpdate(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker;
  if (container.controller === null) return;
  reloadAfterControllerChange(container, document, () =>
    window.location.reload(),
  );
  void registerAfterLoad(container);
}

export async function prepareProductionServiceWorkerUpdate(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (registration === undefined) return;
    requestWaitingWorkerActivation(registration);
    await registration.update();
    requestWaitingWorkerActivation(registration);
  } catch {
    // A cache-busting navigation still reaches the network without worker support.
  }
}

export function reloadAfterControllerChange(
  container: ControllerContainer,
  pageDocument: ReloadDocument,
  reload: () => void,
): () => void {
  const controlledAtStartup = container.controller !== null;
  let handled = false;
  const stop = () => {
    container.removeEventListener("controllerchange", controllerChanged);
    pageDocument.removeEventListener("visibilitychange", visibilityChanged);
  };
  const reloadOnce = () => {
    if (handled) return;
    handled = true;
    stop();
    reload();
  };
  const visibilityChanged = () => {
    if (pageDocument.visibilityState === "hidden") reloadOnce();
  };
  const controllerChanged = () => {
    if (!controlledAtStartup || handled) return;
    if (
      pageDocument.querySelector(
        "[data-initial-splash]:not([data-state='leaving'])",
      ) !== null ||
      pageDocument.visibilityState === "hidden"
    ) {
      reloadOnce();
      return;
    }
    pageDocument.addEventListener("visibilitychange", visibilityChanged);
  };
  container.addEventListener("controllerchange", controllerChanged);
  return stop;
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

function requestWaitingWorkerActivation(
  registration: ServiceWorkerRegistration,
): void {
  registration.waiting?.postMessage({ type: "skip_waiting" });
}
