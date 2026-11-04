import { expect, it } from "vitest";
import { decodeDeploymentConfig } from "../hosted/deployment-config";
import { installDebugSection } from "./debug-overlay";

it("includes ignored deployment fields in debug diagnostics", () => {
  decodeDeploymentConfig({ mode: "app", future_overlay_field: true });
  const stop = installDebugSection(window, {
    id: "test",
    title: "test",
    read: () => [],
  });

  expect(document.querySelector("[data-debug-overlay]")).toHaveTextContent(
    "config unknown: app.future_overlay_field",
  );
  stop();
});
