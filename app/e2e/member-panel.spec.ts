import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { screenshotWithInter } from "./inter-font";
import { IrcClient } from "./irc-client";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { expectAlignedPrefixColumn } from "./prefix-column-geometry";

const channel = "#weblounge-test";
const screenshots = path.join(process.cwd(), "e2e", "screenshots");

test.describe("desktop members against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("updates groups, toggles, and opens a DM", async ({ page }) => {
    const memberChannel = `#member-panel-${Date.now().toString().slice(-6)}`;
    const bot = await IrcClient.connect(
      "member-bot",
      "weblounge-bot",
      "weblounge-bot-test",
      memberChannel,
    );
    let voice: IrcClient | undefined;
    const plainMembers: IrcClient[] = [];
    try {
      await bot.mode("member-bot", "+B");
      await installNativeFeelInstrumentation(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/?irc-password=weblounge-test");
      const composer = page.getByRole("textbox", {
        name: `Message ${channel}`,
      });
      await composer.fill(`/join ${memberChannel}`);
      await composer.press("Enter");
      await expect(
        page.getByRole("heading", { name: memberChannel }),
      ).toBeVisible();

      const toggle = page.getByRole("button", { name: "Toggle member list" });
      await toggle.click();
      const panel = page.getByRole("complementary", { name: "Members" });
      await expect(panel).toHaveCSS("width", "232px");
      await expect(panel.getByText("Online — 1")).toBeVisible();
      await expect(panel.getByText("Bots — 1")).toBeVisible();
      await expect(
        panel.getByRole("button", {
          name: "Open direct message with member-bot",
        }),
      ).toBeVisible();
      const desktopBoxes = await panel
        .locator("li:visible")
        .evaluateAll((rows) =>
          rows
            .map((row) => {
              const box = row.getBoundingClientRect();
              return { top: box.top, bottom: box.bottom };
            })
            .sort((first, second) => first.top - second.top),
        );
      for (let index = 1; index < desktopBoxes.length; index += 1)
        expect(desktopBoxes[index - 1]?.bottom).toBeLessThanOrEqual(
          desktopBoxes[index]?.top ?? 0,
        );
      const desktopStack = await panel.evaluate((element) => ({
        headerBottom:
          element.querySelector("header")?.getBoundingClientRect().bottom ?? 0,
        listTop: element.querySelector("ul")?.getBoundingClientRect().top ?? 0,
      }));
      expect(desktopStack.headerBottom).toBeLessThanOrEqual(
        desktopStack.listTop,
      );

      await bot.mode(memberChannel, "+o", "weblounge");
      await expect(panel.getByText("Operators — 1")).toBeVisible();
      voice = await IrcClient.connect(
        "member-voice",
        "weblounge-bot",
        "weblounge-bot-test",
        memberChannel,
      );
      await bot.mode(memberChannel, "+v", voice.nickname);
      for (const nick of ["member-alex", "member-casey", "member-drew"])
        plainMembers.push(
          await IrcClient.connect(
            nick,
            "weblounge-bot",
            "weblounge-bot-test",
            memberChannel,
          ),
        );
      await expect(
        panel.locator("[data-member-prefix]", { hasText: "+" }),
      ).toBeVisible();
      await expectAlignedPrefixColumn(
        panel,
        "[data-member-prefix]",
        "[data-member-name]",
        {
          avatarSelector: "[data-member-avatar]",
          gapProperty: "--wl-space-list-gap",
        },
      );
      await expectMemberRowsUseDensityPitch(panel);
      await bot.mode(memberChannel, "-o", "weblounge");
      await expect(panel.getByText("Online — 4")).toBeVisible();
      await bot.mode(memberChannel, "+o", "weblounge");
      await expect(panel.getByText("Operators — 1")).toBeVisible();

      await page.keyboard.press("Control+Period");
      await expect(panel).toHaveCount(0);
      await page.keyboard.press("Control+Period");
      await expect(panel).toBeVisible();
      await expect
        .poll(() =>
          panel.evaluate((element) =>
            element
              .getAnimations({ subtree: true })
              .every((animation) => animation.playState === "finished"),
          ),
        )
        .toBe(true);
      await nativeFeelAudit(page);

      await mkdir(screenshots, { recursive: true });
      const memberNames = panel.locator("[data-member-name]");
      await screenshotWithInter(memberNames, {
        path: path.join(screenshots, "member-panel-light.png"),
      });
      await page.emulateMedia({ colorScheme: "dark" });
      await screenshotWithInter(memberNames, {
        path: path.join(screenshots, "member-panel-dark.png"),
      });

      await panel
        .getByRole("button", { name: "Open direct message with member-bot" })
        .click();
      await expect(
        page.getByRole("heading", { name: "member-bot" }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Message member-bot" }),
      ).toBeFocused();
      await expect(panel).toHaveCount(0);
    } finally {
      for (const member of plainMembers) member.close();
      voice?.close();
      bot.close();
    }
  });

  test("resubscribes the open panel when switching channels", async ({
    page,
  }) => {
    const suffix = Date.now().toString().slice(-5);
    const garden = `#members-${suffix}`;
    const roomNick = `room${suffix}`;
    const gardenNick = `garden${suffix}`;
    const gardenExtraNick = `leaf${suffix}`;
    const roomBot = await IrcClient.connect(
      roomNick,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    const gardenBot = await IrcClient.connect(
      gardenNick,
      "weblounge-bot",
      "weblounge-bot-test",
      garden,
    );
    const gardenExtraBot = await IrcClient.connect(
      gardenExtraNick,
      "weblounge-bot",
      "weblounge-bot-test",
      garden,
    );
    try {
      await page.goto("/?irc-password=weblounge-test");
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();
      const composer = page.getByRole("textbox", {
        name: `Message ${channel}`,
      });
      await composer.fill(`/join ${garden}`);
      await composer.press("Enter");
      const gardenButton = page.getByRole("button", { name: garden });
      await expect(gardenButton).toBeVisible();
      await page.getByRole("button", { name: channel }).click();

      await page.getByRole("button", { name: "Toggle member list" }).click();
      const panel = page.getByRole("complementary", { name: "Members" });
      await expect(
        panel.getByRole("button", {
          name: `Open direct message with ${roomNick}`,
        }),
      ).toBeVisible();
      await expect(panel.getByText("2", { exact: true })).toBeVisible();
      await gardenButton.click();
      await expect(
        panel.getByRole("button", {
          name: `Open direct message with ${gardenNick}`,
        }),
      ).toBeVisible();
      await expect(panel.getByText("3", { exact: true })).toBeVisible();
      await expect(panel.getByText(roomNick, { exact: true })).toHaveCount(0);

      await page.getByRole("button", { name: channel }).click();
      await expect(
        panel.getByRole("button", {
          name: `Open direct message with ${roomNick}`,
        }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Hide members" }).click();
      await gardenButton.click();
      await page.getByRole("button", { name: "Toggle member list" }).click();
      await expect(
        panel.getByRole("button", {
          name: `Open direct message with ${gardenNick}`,
        }),
      ).toBeVisible();
    } finally {
      roomBot.close();
      gardenBot.close();
      gardenExtraBot.close();
    }
  });

  test("slides the narrow member drawer closed from its panel control", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 500, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/?irc-password=weblounge-test");
    await expect(page.getByRole("heading", { name: channel })).toBeVisible();
    await page.getByRole("button", { name: "Toggle member list" }).click();
    await expect(page.locator("[data-overlay-drawer]")).toHaveAttribute(
      "data-phase",
      "open",
    );

    const frames = await recordPanelClose(page);
    const present = frames.filter((left): left is number => left !== null);
    expect(new Set(present.map(Math.round)).size).toBeGreaterThanOrEqual(7);
    expect(
      present.every(
        (left, index) => index === 0 || left >= (present[index - 1] ?? left),
      ),
    ).toBe(true);
    expect(present.at(-1)).toBeGreaterThanOrEqual(499.5);
    await expect(page.getByRole("dialog", { name: "Members" })).toHaveCount(0);
  });
});

async function expectMemberRowsUseDensityPitch(panel: Locator) {
  const rows = await panel
    .locator("[data-member-row-kind]")
    .evaluateAll((elements) => {
      const panelElement = elements[0]?.closest<HTMLElement>("aside");
      if (panelElement === undefined || panelElement === null) return [];
      const styles = getComputedStyle(panelElement);
      const heights = {
        group: Number.parseFloat(
          styles.getPropertyValue("--wl-member-group-row-height"),
        ),
        member: Number.parseFloat(
          styles.getPropertyValue("--wl-density-sidebar-member-row-height"),
        ),
      };
      return elements.map((element) => {
        const row = element as HTMLElement;
        const kind = row.dataset.memberRowKind;
        const box = row.getBoundingClientRect();
        return {
          top: box.top,
          height: box.height,
          expectedHeight: kind === "group" ? heights.group : heights.member,
        };
      });
    });

  expect(rows.length).toBeGreaterThanOrEqual(4);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    expect(Math.abs(row.height - row.expectedHeight)).toBeLessThanOrEqual(0.5);
    const next = rows[index + 1];
    if (next !== undefined)
      expect(
        Math.abs(next.top - row.top - row.expectedHeight),
      ).toBeLessThanOrEqual(0.5);
  }
}

async function recordPanelClose(
  page: import("@playwright/test").Page,
): Promise<readonly (number | null)[]> {
  return page.evaluate(
    () =>
      new Promise<readonly (number | null)[]>((resolve, reject) => {
        const frames: (number | null)[] = [];
        const startedAt = performance.now();
        document
          .querySelector<HTMLElement>(
            '[role="dialog"] button[aria-label="Hide members"]',
          )
          ?.click();
        const sample = () => {
          const drawer = document.querySelector<HTMLElement>(
            '[data-overlay-drawer] [role="dialog"]',
          );
          frames.push(drawer?.getBoundingClientRect().left ?? null);
          if (drawer === null) resolve(frames);
          else if (performance.now() - startedAt > 3_000)
            reject(new Error(`drawer did not close: ${frames.length} frames`));
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
}
