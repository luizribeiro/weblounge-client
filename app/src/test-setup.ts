import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach, beforeEach, vi } from "vitest";

beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  ),
);

afterEach(cleanup);
afterEach(() => document.body.replaceChildren());
afterEach(() => vi.unstubAllGlobals());
