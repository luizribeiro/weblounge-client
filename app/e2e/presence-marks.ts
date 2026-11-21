import { expect, type Locator, type Page } from "@playwright/test";
import type { PeerPresence } from "../src/engine/generated/PeerPresence";
import { tokenColour } from "./sidebar-geometry";

const transparent = "rgba(0, 0, 0, 0)";

/** Online is a filled dot, away a crescent cut from a muted disc, offline a hollow muted ring. */
export async function expectPresenceDot(
  page: Page,
  dot: Locator,
  presence: PeerPresence,
): Promise<void> {
  await expect(dot).toHaveAttribute("data-presence", presence);
  const online = await tokenColour(page, "--wl-color-online");
  const muted = await tokenColour(page, "--wl-color-panel-muted");
  const look = {
    online: { fill: online, ring: online, crescent: false },
    away: { fill: transparent, ring: transparent, crescent: true },
    offline: { fill: transparent, ring: muted, crescent: false },
  }[presence];
  await expect(dot).toHaveCSS("background-color", look.fill);
  await expect(dot).toHaveCSS("border-top-color", look.ring);
  await expect(dot).toHaveCSS(
    "background-image",
    look.crescent ? /^radial-gradient\(/u : "none",
  );
}

/** A bot keeps its robot, in the online colour only while online, wearing the dot as a badge. */
export async function expectBotPresence(
  page: Page,
  robot: Locator,
  presence: PeerPresence,
): Promise<void> {
  await expect(robot).toHaveAttribute("data-presence", presence);
  await expect(robot).toHaveCSS(
    "color",
    await tokenColour(
      page,
      presence === "online" ? "--wl-color-online" : "--wl-color-panel-muted",
    ),
  );
  await expect(robot).toHaveCSS("opacity", "1");
  await expect(robot.locator("[aria-hidden='true']")).toBeVisible();
}
