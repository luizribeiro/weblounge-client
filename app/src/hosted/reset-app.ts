const appCachePrefix = "weblounge-";
const serviceWorkerPath = "/service-worker.js";

export async function resetWebApp(): Promise<void> {
  await Promise.allSettled([unregisterAppWorkers(), deleteAppCaches()]);
  window.location.reload();
}

async function unregisterAppWorkers(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations
      .filter(isAppWorker)
      .map((registration) => registration.unregister()),
  );
}

function isAppWorker(registration: ServiceWorkerRegistration): boolean {
  return [registration.active, registration.installing, registration.waiting]
    .filter((worker) => worker !== null)
    .some((worker) => new URL(worker.scriptURL).pathname === serviceWorkerPath);
}

async function deleteAppCaches(): Promise<void> {
  if (!("caches" in globalThis)) return;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(appCachePrefix))
      .map((name) => caches.delete(name)),
  );
}
