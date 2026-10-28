import { afterEach, describe, expect, it } from "vitest";
import {
  densityDefaults,
  densityPresets,
  densityStyleSheet,
  installDensity,
} from "./density";

afterEach(() => document.querySelector("[data-density-tokens]")?.remove());

describe("density presets", () => {
  it("matches Appendix B and keeps independent defaults", () => {
    expect(densityPresets.compact.sidebarRowHeight).toBe("26px");
    expect(densityPresets.cozy.oneLineRowPadding).toBe("3px");
    expect(densityPresets.comfortable.mobileAvatar).toBe("48px");
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

    dispose();
    expect(document.querySelector("[data-density-tokens]")).toBeNull();
  });
});
