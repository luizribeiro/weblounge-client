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
    expect(densityPresets.cozy.dividerTopPadding).toBe("14px");
    expect(densityPresets.cozy.dividerBottomPadding).toBe("6px");
    expect(densityPresets.cozy.mobileDividerTopPadding).toBe("20px");
    expect(densityPresets.cozy.mobileDividerBottomPadding).toBe("8px");
    expect(densityPresets.cozy.mobileLineTopPadding).toBe("12px");
    expect(densityPresets.compact.dividerTopPadding).toBe("10px");
    expect(densityPresets.compact.dividerBottomPadding).toBe("4px");
    expect(densityPresets.comfortable.dividerTopPadding).toBe("18px");
    expect(densityPresets.comfortable.dividerBottomPadding).toBe("8px");
    expect(densityPresets.compact.mobileDividerTopPadding).toBe("16px");
    expect(densityPresets.compact.mobileDividerBottomPadding).toBe("6px");
    expect(densityPresets.comfortable.mobileDividerTopPadding).toBe("24px");
    expect(densityPresets.comfortable.mobileDividerBottomPadding).toBe("10px");
    expect(densityPresets.cozy.mobileLineGapPadding).toBe("4px");
    expect(densityPresets.comfortable.mobileAvatar).toBe("48px");
    expect(densityPresets.compact.mobileLineTopPadding).toBe("8px");
    expect(densityPresets.comfortable.mobileLineTopPadding).toBe("16px");
    expect(densityPresets.compact.mobileLineGapPadding).toBe("2px");
    expect(densityPresets.comfortable.mobileLineGapPadding).toBe("6px");
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
