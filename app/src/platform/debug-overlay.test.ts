import { expect, it } from "vitest";
import { decodeDeploymentConfig } from "../hosted/deployment-config";
import {
  installDebugSection,
  setNotificationDebugReading,
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
