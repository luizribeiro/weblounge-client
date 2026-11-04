import { expect, it } from "vitest";
import { decodeDeploymentConfig } from "../hosted/deployment-config";
import {
  installDebugSection,
  installDefaultDebug,
  installPushDebug,
  setNotificationDebugReading,
  setPushDebugSnapshot,
} from "./debug-overlay";

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
