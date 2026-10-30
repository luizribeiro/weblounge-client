import { describe, expect, it } from "vitest";
import { platformBoundaryViolations } from "./platform-boundary-policy";

describe("platform boundary policy", () => {
  it.each([
    ["matchMedia", 'window.matchMedia("(pointer: coarse)")'],
    ["safe area", "padding: env(safe-area-inset-bottom);"],
    ["platform", "navigator.platform"],
    ["user agent", "navigator.userAgentData"],
    ["breakpoint", "@media (max-width: 600px) {\n  button {}\n}"],
    ["multiline breakpoint", "@media (\n  max-width: 600px\n) {}"],
  ])("rejects stray %s adaptation", (_name, source) => {
    expect(
      platformBoundaryViolations("app/src/features/example.ts", source),
    ).toHaveLength(1);
  });

  it("allows the platform module to own adaptation", () => {
    const source = [
      'window.matchMedia("(pointer: coarse)")',
      "navigator.platform",
      "padding: env(safe-area-inset-bottom)",
      "@media (max-width: 600px) {}",
    ].join("\n");

    expect(
      platformBoundaryViolations("app/src/platform/environment.ts", source),
    ).toEqual([]);
  });

  it("does not confuse ordinary maximum widths with media breakpoints", () => {
    expect(
      platformBoundaryViolations(
        "app/src/ui/Drawer.module.css",
        ".drawer { max-width: 82%; }",
      ),
    ).toEqual([]);
  });
});
