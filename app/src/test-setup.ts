import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach, beforeEach, vi } from "vitest";
import {
  installPlatformEnvironment,
  type PlatformController,
} from "./platform/environment";

let platform: PlatformController | undefined;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  platform = installPlatformEnvironment(document.body, window);
});

afterEach(cleanup);
afterEach(() => platform?.dispose());
afterEach(() => document.body.replaceChildren());
afterEach(() => vi.unstubAllGlobals());
