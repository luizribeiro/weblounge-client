import type { Page } from "@playwright/test";
import { snapshotRow } from "./engine-database";
import type { IrcClient } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";
import { useDedicatedWorker } from "./production-ergo";
import { expectSettled } from "./settled";
import { closeFromSidebar, openFromSwitcher } from "./sidebar-rows";

test.describe("a DM opened after a new line still shows its earlier history", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("when the line arrived while the app was closed", async ({
    context,
    page,
    irc,
  }) => {
    const keeper = await irc.self([irc.channel]);
    const peer = await irc.peer("closed-app");
    // A SharedWorker engine can outlive its last tab, and the next tab would attach to it
    // instead of relaunching from the cached chat list.
    await useDedicatedWorker(page);
    const earlier = await readEarlierDirects(page, irc, peer);
    await expect.poll(() => keeper.readMarker(peer.nickname)).toBeDefined();
    const marker = Date.parse((await keeper.readMarker(peer.nickname)) ?? "");
    await expect
      .poll(() => snapshotRow(page, peer.nickname))
      .toMatchObject({ read_at_ms: marker });
    await page.close();

    const latest = `arrived while closed ${irc.id}`;
    await peer.privmsgConfirmed(irc.account, latest);
    const relaunched = await context.newPage();
    await installNativeFeelInstrumentation(relaunched);
    await relaunched.goto(irc.url({ path: channelPath(irc) }));
    // The unread line comes from the catch-up page; opening the DM before it lands takes a
    // different path that loads the latest page.
    await expect(directRow(relaunched, peer.nickname)).toHaveAttribute(
      "data-unread",
      "1",
    );

    await openFromSwitcher(relaunched, peer.nickname);
    await expectTranscript(relaunched, earlier, latest);
    await expectSettled(relaunched, { conversation: peer.nickname });
    await nativeFeelAudit(relaunched);
  });

  test("when the line arrived live after the DM was closed and the app reloaded", async ({
    page,
    irc,
  }) => {
    await irc.self([irc.channel]);
    const peer = await irc.peer("closed-dm");
    await installNativeFeelInstrumentation(page);
    const earlier = await readEarlierDirects(page, irc, peer);
    await closeFromSidebar(page, directRow(page, peer.nickname), peer.nickname);
    await page.goto(irc.url({ path: channelPath(irc) }));
    await expect(page.locator('[data-network-state="online"]')).toHaveCount(1);

    const latest = `arrived live ${irc.id}`;
    await peer.privmsgConfirmed(irc.account, latest);
    await expect(directRow(page, peer.nickname)).toBeVisible();

    await openFromSwitcher(page, peer.nickname);
    await expectTranscript(page, earlier, latest);
    await expectSettled(page, { conversation: peer.nickname });
    await nativeFeelAudit(page);
  });
});

async function readEarlierDirects(
  page: Page,
  irc: IrcTestAccount,
  peer: IrcClient,
): Promise<readonly string[]> {
  const earlier = [1, 2, 3].map((index) => `earlier direct ${index} ${irc.id}`);
  const channelRow = page.getByRole("button", {
    name: irc.channel,
    exact: true,
  });
  await page.goto(irc.url());
  await channelRow.click();
  for (const text of earlier) await peer.privmsgConfirmed(irc.account, text);
  await directRow(page, peer.nickname).click();
  await expect(
    transcript(page).getByText(earlier.at(-1) ?? "", { exact: true }),
  ).toBeVisible();
  await expect(directRow(page, peer.nickname)).toHaveAttribute(
    "data-unread",
    "0",
  );
  await expectSettled(page, { conversation: peer.nickname });
  await channelRow.click();
  return earlier;
}

async function expectTranscript(
  page: Page,
  earlier: readonly string[],
  latest: string,
): Promise<void> {
  for (const text of [...earlier, latest])
    await expect(
      transcript(page).getByText(text, { exact: true }),
    ).toBeVisible();
  await expect(transcript(page).getByText(latest, { exact: true })).toHaveCount(
    1,
  );
}

function transcript(page: Page) {
  return page.getByRole("list", { name: "Messages" });
}

function directRow(page: Page, nickname: string) {
  return page.getByRole("button", {
    name: new RegExp(`^${nickname}(?:,|$)`, "u"),
  });
}

function channelPath(irc: IrcTestAccount): string {
  return `/Local%20Ergo/${irc.channel.slice(1)}`;
}
