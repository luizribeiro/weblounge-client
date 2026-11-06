import { expect, it, vi } from "vitest";
import { decodeDeploymentConfig } from "../hosted/deployment-config";
import {
  installDebugSection,
  installDefaultDebug,
  installPushDebug,
  setEngineDebugReading,
  setNotificationDebugReading,
  setPushDebugSnapshot,
} from "./debug-overlay";
import { foregroundLog } from "./push/foreground-log";

it("records the latest engine failure in debug diagnostics", () => {
  setEngineDebugReading(
    window,
    "engine.mark_read_failed",
    "Couldn't mark this conversation as read.",
  );
  setEngineDebugReading(
    window,
    "engine.read_marker_invalid",
    "That read position is no longer available.",
  );
  setEngineDebugReading(
    window,
    "engine.mark_read_failed",
    "Still couldn't mark this conversation as read.",
  );
  const stop = installDefaultDebug(document.createElement("div"), window);

  expect(document.querySelector("[data-debug-overlay]")).toHaveTextContent(
    "engine: Still couldn't mark this conversation as read. / That read position is no longer available.",
  );
  stop();
  setEngineDebugReading(window, "engine.mark_read_failed", undefined);
  setEngineDebugReading(window, "engine.read_marker_invalid", undefined);
});

it("renders and copies the foreground activity log", () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  foregroundLog.append({
    monotonicMs: 12,
    wallTimeMs: Date.UTC(2026, 10, 5, 12),
    event: {
      type: "lifecycle",
      kind: "blur",
      snapshot: {
        visibility: "visible",
        hasFocus: false,
        hidden: false,
        navigatorStandalone: true,
        displayModeStandalone: true,
        foreground: true,
      },
    },
  });
  const stop = installDefaultDebug(document.createElement("div"), window);

  expect(document.querySelector("[data-debug-overlay]")).toHaveTextContent(
    "blur visibility=visible focus=false",
  );
  const copy = document.querySelector<HTMLButtonElement>(
    "[data-foreground-log-copy]",
  );
  expect(copy?.closest("[data-debug-overlay]")).not.toHaveAttribute(
    "aria-hidden",
  );
  copy?.click();
  expect(writeText).toHaveBeenCalledWith(
    expect.stringContaining("navigator-standalone=true"),
  );
  stop();
  Reflect.deleteProperty(window.navigator, "clipboard");
});

it("includes ignored deployment fields in debug diagnostics", () => {
  decodeDeploymentConfig({ mode: "app", future_overlay_field: true });
  setNotificationDebugReading(
    window,
    "configured=true / supported=true / permission=default / dismissed=pending / ios=false / display=browser",
  );
  const stop = installDebugSection(window, {
    id: "test",
    title: "test",
    read: () => [],
  });

  expect(document.querySelector("[data-debug-overlay]")).toHaveTextContent(
    "config unknown: app.future_overlay_field",
  );
  expect(document.querySelector("[data-debug-overlay]")).toHaveTextContent(
    "notifications: configured=true / supported=true / permission=default / dismissed=pending / ios=false / display=browser",
  );
  stop();
  setNotificationDebugReading(window, undefined);
});

it("shows a push summary in every overlay and details in the push view", () => {
  setPushDebugSnapshot(window, {
    summary:
      "network Lounge: engine=Failed(invalid_parameters) / relay=probing (route-12) / last error=none",
    readings: [
      ["prompt", "configured=true / supported=true"],
      [
        "network Lounge",
        "engine=Failed(invalid_parameters) / relay=probing (route-12) / last error=none",
      ],
    ],
  });
  const stopDefault = installDebugSection(window, {
    id: "test",
    title: "test",
    read: () => [],
  });
  expect(document.querySelector("[data-debug-overlay]")).toHaveTextContent(
    "push: network Lounge: engine=Failed(invalid_parameters)",
  );
  stopDefault();

  const root = document.createElement("div");
  const stopSummary = installDefaultDebug(root, window);
  expect(document.querySelector("[data-debug-overlay]")).toHaveTextContent(
    "[debug]",
  );
  expect(document.querySelector("[data-debug-overlay]")).toHaveTextContent(
    "push: network Lounge: engine=Failed(invalid_parameters)",
  );
  stopSummary();

  const stopPush = installPushDebug(root, window);
  expect(document.querySelector("[data-debug-overlay]")).toHaveTextContent(
    "[push]",
  );
  expect(document.querySelector("[data-debug-overlay]")).toHaveTextContent(
    "prompt: configured=true / supported=true",
  );
  stopPush();
  setPushDebugSnapshot(window, undefined);
});
