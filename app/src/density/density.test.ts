import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  densityDefaults,
  densityPresets,
  densityStyleSheet,
  installDensity,
} from "./density";

describe("density presets", () => {
  it("matches Appendix B and keeps independent defaults", () => {
    expect(densityPresets.compact.sidebarRowHeight).toBe("26px");
    expect(densityPresets.cozy.oneLineRowPadding).toBe("3px");
    expect(densityPresets.cozy.dividerPadding).toBe("10px");
    expect(densityPresets.cozy.mobileDividerPadding).toBe("14px");
    expect(densityPresets.cozy.mobileLineAfterMessagePadding).toBe("12px");
    expect(densityPresets.compact.dividerPadding).toBe("6px");
    expect(densityPresets.comfortable.dividerPadding).toBe("14px");
    expect(densityPresets.compact.mobileDividerPadding).toBe("10px");
    expect(densityPresets.comfortable.mobileDividerPadding).toBe("18px");
    expect(densityPresets.cozy.mobileLinePadding).toBe("4px");
    expect(densityPresets.comfortable.mobileAvatar).toBe("48px");
    for (const token of [
      "mobileLineAfterMessagePadding",
      "mobileLinePadding",
    ] as const) {
      expect(
        Number.parseFloat(densityPresets.compact[token]) /
          Number.parseFloat(densityPresets.cozy[token]),
      ).toBe(0.75);
      expect(
        Number.parseFloat(densityPresets.comfortable[token]) /
          Number.parseFloat(densityPresets.cozy[token]),
      ).toBe(1.25);
    }
    expect(densityDefaults).toEqual({
      messageLayout: "oneLine",
      message: "cozy",
      desktopList: "compact",
      mobileList: "cozy",
    });
  });

  it("emits variables selected through root settings", () => {
    const dispose = installDensity(document);

    expect(document.documentElement.dataset.sidebarDensity).toBe("compact");
    expect(document.documentElement.dataset.messageDensity).toBe("cozy");
    expect(densityStyleSheet()).toContain(
      "--wl-density-sidebar-row-height:26px",
    );
    expect(densityStyleSheet()).toContain(
      "--wl-density-message-one-line-row-padding:3px",
    );
    expect(
      compactCss(readFileSync("src/styles/density-tokens.css", "utf8")),
    ).toBe(compactCss(densityStyleSheet()));

    dispose();
  });
});

function compactCss(value: string): string {
  return value.replaceAll(/\s+/g, "").replaceAll(";}", "}");
}
