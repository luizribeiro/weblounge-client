import { describe, expect, it, vi } from "vitest";
import {
  mobileShellBoundary,
  observeContainerShell,
  shellForWidth,
} from "./shell-selection";

describe("shell selection", () => {
  it("switches at the exact container boundary", () => {
    expect(shellForWidth(mobileShellBoundary - 1)).toBe("mobile");
    expect(shellForWidth(mobileShellBoundary)).toBe("desktop");
  });

  it("observes the app container instead of the user agent", () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    let callback: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(next: ResizeObserverCallback) {
          callback = next;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const onShell = vi.fn();
    const element = {} as Element;
    const dispose = observeContainerShell(element, onShell);

    callback?.(
      [{ contentRect: { width: 402 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
    expect(observe).toHaveBeenCalledWith(element);
    expect(onShell).toHaveBeenCalledWith("mobile");
    dispose();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
