import { describe, expect, it, vi } from "vitest";
import {
  prepareProductionServiceWorkerUpdate,
  reloadAfterControllerChange,
  settleProductionServiceWorkerUpdate,
  updateProductionServiceWorker,
  waitForServiceWorkerActivation,
} from "./service-worker";

describe("service worker controller activation", () => {
  it("updates the registration and activates its waiting worker", async () => {
    const postMessage = vi.fn();
    const update = vi.fn(async () => registration);
    const registration = {
      waiting: { postMessage },
      update,
    } as unknown as ServiceWorkerRegistration;
    const previous = navigator.serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: vi.fn(async () => registration) },
    });
    try {
      await prepareProductionServiceWorkerUpdate();
      expect(update).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledTimes(2);
      expect(postMessage).toHaveBeenLastCalledWith({ type: "skip_waiting" });
    } finally {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: previous,
      });
    }
  });

  it("settles an update only after its installing worker activates", async () => {
    const worker = new EventTarget() as EventTarget & {
      state: ServiceWorkerState;
    };
    worker.state = "installing";
    const registration = {
      installing: worker,
      waiting: null,
    } as unknown as ServiceWorkerRegistration;
    let settled = false;

    const activation = waitForServiceWorkerActivation(registration).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    worker.state = "activated";
    worker.dispatchEvent(new Event("statechange"));
    await activation;

    expect(settled).toBe(true);
  });

  it("waits for an update that was promoted to active while activating", async () => {
    const worker = new EventTarget() as EventTarget & {
      state: ServiceWorkerState;
    };
    worker.state = "activating";
    const registration = {
      active: worker,
      installing: null,
      waiting: null,
    } as unknown as ServiceWorkerRegistration;
    let settled = false;

    const activation = waitForServiceWorkerActivation(registration).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    worker.state = "activated";
    worker.dispatchEvent(new Event("statechange"));
    await activation;

    expect(settled).toBe(true);
  });

  it("settles when activation finishes while the listener is attached", async () => {
    const removeEventListener = vi.fn();
    const worker = {
      state: "installing" as ServiceWorkerState,
      addEventListener: vi.fn(() => {
        worker.state = "activated";
      }),
      removeEventListener,
    };
    const registration = {
      active: null,
      installing: worker as unknown as ServiceWorker,
      waiting: null,
    } as unknown as ServiceWorkerRegistration;

    await waitForServiceWorkerActivation(registration);

    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it("runs one update job and waits for its replacement worker", async () => {
    const previous = { state: "activated" } as ServiceWorker;
    const replacement = new EventTarget() as EventTarget & {
      state: ServiceWorkerState;
    };
    replacement.state = "installing";
    const registration = {
      active: previous,
      installing: null,
      waiting: null,
      addEventListener: vi.fn(),
      update: vi.fn(async () => {
        Reflect.set(registration, "installing", replacement);
        return registration;
      }),
    } as unknown as ServiceWorkerRegistration;
    const container = {
      controller: previous,
      getRegistration: vi.fn(async () => registration),
    } as unknown as ServiceWorkerContainer;
    let settled = false;

    const update = updateProductionServiceWorker(container).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(registration.update).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    replacement.state = "activated";
    replacement.dispatchEvent(new Event("statechange"));
    await update;

    expect(settled).toBe(true);
  });

  it("continues push setup when an update check fails", async () => {
    const registration = {
      active: null,
      installing: null,
      waiting: null,
      addEventListener: vi.fn(),
      update: vi.fn().mockRejectedValueOnce(new Error("offline")),
    } as unknown as ServiceWorkerRegistration;
    const container = {
      getRegistration: vi.fn(async () => registration),
    } as unknown as ServiceWorkerContainer;
    const pushSetup = vi.fn();

    await settleProductionServiceWorkerUpdate(
      updateProductionServiceWorker(container),
    ).then(pushSetup);

    expect(registration.update).toHaveBeenCalledOnce();
    expect(pushSetup).toHaveBeenCalledOnce();
  });

  it("continues push setup when worker activation stalls", async () => {
    vi.useFakeTimers();
    const pushSetup = vi.fn();
    const update = settleProductionServiceWorkerUpdate(
      new Promise<void>(() => undefined),
      5_000,
    ).then(pushSetup);

    await vi.advanceTimersByTimeAsync(5_000);
    await update;

    expect(pushSetup).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("reloads an existing client once while startup is covered", () => {
    const container = new EventTarget();
    Reflect.set(container, "controller", {});
    const reload = vi.fn();
    document.body.innerHTML = "<main data-initial-splash></main>";

    reloadAfterControllerChange(
      container as unknown as ServiceWorkerContainer,
      document,
      reload,
    );
    container.dispatchEvent(new Event("controllerchange"));
    container.dispatchEvent(new Event("controllerchange"));

    expect(reload).toHaveBeenCalledOnce();
  });

  it("waits for a visible interactive page to hide", () => {
    const container = new EventTarget();
    Reflect.set(container, "controller", {});
    const pageDocument = new EventTarget() as EventTarget & {
      visibilityState: DocumentVisibilityState;
      querySelector: () => null;
    };
    pageDocument.visibilityState = "visible";
    pageDocument.querySelector = () => null;
    const reload = vi.fn();

    reloadAfterControllerChange(
      container as unknown as ServiceWorkerContainer,
      pageDocument as unknown as Document,
      reload,
    );
    container.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();

    pageDocument.visibilityState = "hidden";
    pageDocument.dispatchEvent(new Event("visibilitychange"));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("waits for a page behind a leaving splash to hide", () => {
    const container = new EventTarget();
    Reflect.set(container, "controller", {});
    const pageDocument = new EventTarget() as EventTarget & {
      visibilityState: DocumentVisibilityState;
      querySelector: typeof document.querySelector;
    };
    pageDocument.visibilityState = "visible";
    pageDocument.querySelector = document.querySelector.bind(document);
    document.body.innerHTML =
      '<main data-initial-splash data-state="leaving"></main>';
    const reload = vi.fn();

    reloadAfterControllerChange(
      container as unknown as ServiceWorkerContainer,
      pageDocument as unknown as Document,
      reload,
    );
    container.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();

    pageDocument.visibilityState = "hidden";
    pageDocument.dispatchEvent(new Event("visibilitychange"));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload a first install", () => {
    const container = new EventTarget();
    Reflect.set(container, "controller", null);
    const reload = vi.fn();

    reloadAfterControllerChange(
      container as unknown as ServiceWorkerContainer,
      document,
      reload,
    );
    Reflect.set(container, "controller", {});
    container.dispatchEvent(new Event("controllerchange"));

    expect(reload).not.toHaveBeenCalled();
  });
});
