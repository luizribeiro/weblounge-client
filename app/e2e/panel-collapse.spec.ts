import type { Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

const widest = 1040;
const narrowest = 600;
const step = 16;
const height = 800;

type DockedPanels =
  | "sidebar and members"
  | "sidebar"
  | "none"
  | "members without sidebar";

const collapseOrder: readonly DockedPanels[] = [
  "sidebar and members",
  "sidebar",
  "none",
];

const narrowingWidths = Array.from(
  { length: Math.floor((widest - narrowest) / step) + 1 },
  (_, index) => widest - index * step,
);

function dockedPanelsOf(sidebar: boolean, members: boolean): DockedPanels {
  if (sidebar) return members ? "sidebar and members" : "sidebar";
  return members ? "members without sidebar" : "none";
}

async function dockedPanelsLeavingNoGap(
  page: Page,
  width: number,
): Promise<DockedPanels> {
  const layout = await page.evaluate(() => {
    const box = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect();
    const sidebar = box('[data-desktop-shell] > [data-sidebar="true"]');
    const members = document
      .querySelector("[data-desktop-pane] aside")
      ?.getBoundingClientRect();
    const main = box("[data-desktop-shell] > main");
    const transcript = box("[data-message-list]");
    const composer = box("[data-desktop-pane] [data-composer]");
    if (!main || !transcript || !composer) {
      throw new Error("the desktop conversation is missing");
    }
    return {
      sidebarRight: sidebar?.right,
      membersLeft: members?.left,
      membersRight: members?.right,
      mainLeft: main.left,
      mainRight: main.right,
      transcriptLeft: transcript.left,
      transcriptRight: transcript.right,
      composerLeft: composer.left,
      composerRight: composer.right,
    };
  });
  expect(layout.mainLeft, `main's left edge at ${width}px`).toBeCloseTo(
    layout.sidebarRight ?? 0,
    0,
  );
  expect(layout.mainRight, `main's right edge at ${width}px`).toBeCloseTo(
    width,
    0,
  );
  expect(layout.transcriptLeft).toBeCloseTo(layout.mainLeft, 0);
  expect(layout.transcriptRight).toBeCloseTo(
    layout.membersLeft ?? layout.mainRight,
    0,
  );
  if (layout.membersRight !== undefined)
    expect(layout.membersRight).toBeCloseTo(layout.mainRight, 0);
  expect(layout.composerLeft).toBeCloseTo(layout.mainLeft, 0);
  expect(layout.composerRight).toBeCloseTo(layout.mainRight, 0);
  return dockedPanelsOf(
    layout.sidebarRight !== undefined,
    layout.membersLeft !== undefined,
  );
}

async function panelsAcross(
  page: Page,
  channel: string,
  widths: readonly number[],
): Promise<DockedPanels[]> {
  const sequence: DockedPanels[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height });
    await expectSettled(page, { conversation: channel });
    sequence.push(await dockedPanelsLeavingNoGap(page, width));
  }
  return sequence;
}

function expectMonotonic(
  widths: readonly number[],
  sequence: readonly DockedPanels[],
  direction: "narrowing" | "widening",
): void {
  const runs = sequence.filter((state, index) => state !== sequence[index - 1]);
  const trace = widths.map((width, index) => `${width}px ${sequence[index]}`);
  expect(runs, `docked panels while ${direction}: ${trace.join(", ")}`).toEqual(
    direction === "narrowing" ? collapseOrder : [...collapseOrder].reverse(),
  );
}

test.describe("desktop panels while the window narrows and widens", () => {
  test("collapse members then the sidebar, and restore them in reverse", async ({
    page,
    irc,
  }) => {
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize({ width: 1440, height });
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    await page.getByRole("button", { name: "Toggle member list" }).click();
    await expect(
      page.getByRole("complementary", { name: `Members of ${irc.channel}` }),
    ).toBeVisible();

    const narrowing = await panelsAcross(page, irc.channel, narrowingWidths);
    expectMonotonic(narrowingWidths, narrowing, "narrowing");
    const wideningWidths = [...narrowingWidths].reverse();
    const widening = await panelsAcross(page, irc.channel, wideningWidths);
    expectMonotonic(wideningWidths, widening, "widening");
    await nativeFeelAudit(page);
  });

  test("docks the members beside a sidebar the user hid in a medium window", async ({
    page,
    irc,
  }) => {
    const medium = 800;
    await installNativeFeelInstrumentation(page);
    await page.setViewportSize({ width: 1440, height });
    await page.goto(irc.url());
    await expectSettled(page, { conversation: irc.channel });
    await page.getByRole("button", { name: "Toggle member list" }).click();
    await page.setViewportSize({ width: medium, height });
    await expectSettled(page, { conversation: irc.channel });
    expect(await dockedPanelsLeavingNoGap(page, medium)).toBe("sidebar");

    await page.getByRole("button", { name: "Toggle channel list" }).click();
    await expectSettled(page, { conversation: irc.channel });
    expect(await dockedPanelsLeavingNoGap(page, medium)).toBe(
      "members without sidebar",
    );
    await nativeFeelAudit(page);
  });
});
