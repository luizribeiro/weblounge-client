import { describe, expect, it, vi } from "vitest";
import {
  prepareProductionServiceWorkerUpdate,
  reloadAfterControllerChange,
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
