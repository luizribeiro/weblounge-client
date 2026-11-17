import { expect, test } from "./irc-fixture";
import { expectSettled, pendingSettle, settleProbeInput } from "./settled";

test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1",
  "requires the flake's local Ergo fixture",
);

test("reports a transcript scroll written just before the settle check", async ({
  irc,
  page,
}) => {
  await page.goto(irc.url());
  await expectSettled(page, { conversation: irc.channel });
  const peer = await irc.peer("settled-scroll");
  for (let index = 1; index <= 40; index += 1)
    await peer.privmsgConfirmed(irc.channel, `line ${index}`);
  await expect(page.getByText("line 40", { exact: true })).toBeVisible();
  await expectSettled(page, { conversation: irc.channel });

  // One evaluate, so the probe starts in the same task as the scroll it must not miss.
  const { moved, pending } = await page.evaluate<{
    moved: boolean;
    pending: string[];
  }>(
    `(async () => {
      const list = document.querySelector("[data-message-list]");
      const before = list.scrollTop;
      list.scrollTop -= 200;
      const moved = list.scrollTop !== before;
      const pending = await (${pendingSettle.toString()})(${JSON.stringify(settleProbeInput())});
      return { moved, pending };
    })()`,
  );

  expect(moved).toBe(true);
  expect(pending).toEqual(["transcript scroll"]);
  await expectSettled(page, { conversation: irc.channel });
});
