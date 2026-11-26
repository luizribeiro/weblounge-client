import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContextOptions, Locator, Page } from "@playwright/test";
import type { PeerPresence } from "../src/engine/generated/PeerPresence";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectPresenceDot } from "./presence-marks";
import { choose, choosePhoneAppearance } from "./settings-fixture";
import { backToChatList, expectSettled } from "./settled";
import { expectCentredOnText } from "./text-centre";

const screenshotDirectory = path.join(
  process.cwd(),
  "e2e",
  "screenshots",
  "dm-presence",
);

interface Layout {
  readonly name: string;
  readonly context: BrowserContextOptions;
  readonly listedWhileOpen: boolean;
}

const layouts: readonly Layout[] = [
  {
    name: "desktop",
    context: { viewport: { width: 1_280, height: 800 } },
    listedWhileOpen: true,
  },
  {
    name: "phone",
    context: {
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    },
    listedWhileOpen: false,
  },
];

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

for (const layout of layouts) {
  test(`${layout.name}: a DM peer sharing no channel shows online, away, then offline`, async ({
    browser,
    baseURL,
    irc,
  }) => {
    const peer = await irc.peer("ana", []);
    const context = await browser.newContext({ baseURL, ...layout.context });
    await irc.scope(context);
    const page = await context.newPage();
    try {
      await installNativeFeelInstrumentation(page);
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(irc.url());
      await expectJoined(page, layout, irc.channel);
      await peer.privmsgConfirmed(irc.account, `hello ${irc.id}`);
      const row = await directRow(page, peer.nickname);
      const mark = row.locator("[data-presence-dot]");
      await expectPresenceDot(page, mark, "online");

      await row.click();
      await expectSettled(page, { conversation: peer.nickname });
      const header = page.locator("[data-direct-presence]");
      await expectHeader(page, header, "online", statuses.online);
      await capture(page, layout, "online");

      await peer.setAway("lunch");
      await expectHeader(page, header, "away", statuses.awaySince);
      if (layout.listedWhileOpen) await expectPresenceDot(page, mark, "away");
      await capture(page, layout, "away");

      peer.close();
      await peer.waitForDisconnect();
      await expectHeader(page, header, "offline", statuses.lastSeen);
      if (!layout.listedWhileOpen)
        await expect(
          page.getByRole("button", {
            name: new RegExp(
              `^${peer.nickname}, ${statuses.lastSeen.source.slice(1)}`,
              "u",
            ),
          }),
        ).toBeVisible();
      await capture(page, layout, "offline");
      await nativeFeelAudit(page);

      if (!layout.listedWhileOpen) await backToChatList(page, peer.nickname);
      await expectPresenceDot(page, mark, "offline");
      await captureNe(page, layout, row);
    } finally {
      peer.close();
      await context.close();
    }
  });
}

/** The peer's line only reaches us once we are registered, which a shown channel proves. */
async function expectJoined(
  page: Page,
  layout: Layout,
  channel: string,
): Promise<void> {
  if (!layout.listedWhileOpen) {
    await page.getByRole("button", { exact: true, name: channel }).click();
  }
  await expectSettled(page, { conversation: channel });
  if (!layout.listedWhileOpen) await backToChatList(page, channel);
}

/** The row's label drops its unread badge once the DM is read, so it is found again by buffer. */
async function directRow(page: Page, nick: string): Promise<Locator> {
  const unread = page.locator(`[data-buffer-id][aria-label^="${nick},"]`);
  await expect(unread).toBeVisible();
  const id = await unread.getAttribute("data-buffer-id");
  return page.locator(`[aria-label][data-buffer-id="${id}"]`);
}

/** Times appear only for changes this session saw: the AWAY and the quit in this test. */
const statuses = {
  online: /^Online$/u,
  awaySince: /^Away since \S.*$/u,
  lastSeen: /^Offline, last seen \S.*$/u,
} as const;

async function expectHeader(
  page: Page,
  header: Locator,
  presence: PeerPresence,
  status: RegExp,
): Promise<void> {
  await expect(header).toHaveText(status);
  const mark = header.locator("[data-presence-dot]");
  await expectPresenceDot(page, mark, presence);
  await expectCentredOnText(mark, header.locator("[data-line]"));
}

async function capture(
  page: Page,
  layout: Layout,
  presence: PeerPresence,
): Promise<void> {
  await mkdir(screenshotDirectory, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      scheme === "light" ? "lounge" : "lounge-night",
    );
    await page.screenshot({
      path: path.join(
        screenshotDirectory,
        `${layout.name}-${presence}-${scheme}.png`,
      ),
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** n.e. is a chosen theme rather than a system scheme, so it is captured once, at the end. */
async function captureNe(page: Page, layout: Layout, row: Locator) {
  if (layout.listedWhileOpen) {
    await page
      .getByRole("complementary", { name: "Channel list" })
      .getByRole("button", { name: "Settings" })
      .click();
    await choose(page, "n.e.");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
  } else {
    await choosePhoneAppearance(page, ["n.e."]);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "ne");
    await page.screenshot({
      path: path.join(screenshotDirectory, "phone-list-offline-ne.png"),
    });
    await row.click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ne");
  await expect(page.locator("[data-direct-presence]")).toHaveText(
    statuses.lastSeen,
  );
  await page.screenshot({
    path: path.join(screenshotDirectory, `${layout.name}-offline-ne.png`),
  });
}
