import type { Page } from "@playwright/test";
import { expect, test } from "./irc-fixture";
import { expectSettled } from "./settled";

test.describe("buffer order against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("keeps channel order stable across three reloads", async ({
    page,
    irc,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, "SharedWorker", {
        configurable: true,
        value: undefined,
      });
    });
    const suffix = irc.id;
    const channels = [
      `#zzz-stable-${suffix}`,
      `#aaa-stable-${suffix}`,
      `#mmm-stable-${suffix}`,
    ];
    const expected = [...channels].sort((first, second) =>
      first.slice(1).localeCompare(second.slice(1)),
    );
    const arrivals = [
      channels,
      [channels[2], channels[0], channels[1]],
      [channels[1], channels[2], channels[0]],
      [channels[0], channels[2], channels[1]],
    ];

    for (const [index, arrival] of arrivals.entries()) {
      if (index === 0) {
        await page.goto(irc.url());
      } else {
        await page.evaluate(
          (url) => history.replaceState(null, "", url),
          irc.url(),
        );
        await page.reload();
      }
      await page.getByRole("button", { name: irc.channel }).click();
      await expectSettled(page, { conversation: irc.channel });
      await expect(page.locator('[data-network-state="online"]')).toHaveCount(
        1,
      );
      const composer = page.getByRole("textbox", { name: "Message" });
      for (const channel of arrival) {
        if (channel === undefined) continue;
        const existing = page.getByRole("button", { name: channel });
        if ((await existing.count()) === 0) {
          await composer.fill(`/join ${channel}`);
          await composer.press("Enter");
        } else {
          await existing.click();
        }
        await expect(
          page.getByRole("heading", { name: channel }),
        ).toBeVisible();
      }
      await expectStableChannelOrder(page, `-stable-${suffix}`, expected);
    }
  });
});

async function expectStableChannelOrder(
  page: Page,
  suffix: string,
  expected: readonly string[],
): Promise<void> {
  await expect
    .poll(async () =>
      page
        .locator("[data-buffer-id]")
        .evaluateAll(
          (rows, marker) =>
            rows
              .map((row) => row.getAttribute("aria-label") ?? "")
              .filter((name) => name.includes(String(marker))),
          suffix,
        ),
    )
    .toEqual(expected);
}
