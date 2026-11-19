import {
  composerNotice,
  joinFirst,
  member,
  showMembers,
} from "./channel-commands";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";

const kickUsage = "<nick> [reason] · Remove someone from this channel";

test.describe("/kick against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.use({ viewport: { width: 1280, height: 800 } });

  test("an op completes the nick and kicks with a reason", async ({
    page,
    irc,
  }) => {
    await installNativeFeelInstrumentation(page);
    const channel = irc.channelNamed("kick-op");
    const composer = await joinFirst(page, irc, channel);
    const peer = await irc.peer("kickee", [channel]);
    const members = await showMembers(page, channel);
    await expect(member(members, peer.nickname)).toBeVisible();

    await composer.pressSequentially("/ki");
    await expect(page.getByRole("option", { name: /\/kick/u })).toBeVisible();
    await expect(page.getByText(kickUsage)).toBeVisible();
    await composer.fill("");

    await composer.pressSequentially(`/kick ${peer.nickname.slice(0, 5)}`);
    await expect(page.getByText("/kick <nick> [reason]")).toBeVisible();
    const suggestion = page.getByRole("option", {
      name: new RegExp(peer.nickname, "u"),
    });
    await expect(suggestion).toBeVisible();
    await composer.press("Enter");
    await expect(composer).toHaveValue(`/kick ${peer.nickname} `);
    await composer.pressSequentially("link spam");
    await composer.press("Enter");

    const kickLine = page
      .locator("[data-system-line]")
      .filter({ hasText: `You kicked ${peer.nickname}` });
    await expect(kickLine).toHaveAccessibleName(
      `You kicked ${peer.nickname}: “link spam”`,
    );
    await expect(kickLine).toHaveAttribute("data-warning", "false");
    await expect(member(members, peer.nickname)).toHaveCount(0);
    await expect(composer).toHaveValue("");
    await nativeFeelAudit(page);
  });

  test("a non-op gets a readable refusal", async ({ page, irc }) => {
    const channel = irc.channelNamed("kick-peer");
    const operator = await irc.peer("chanop", [channel]);
    const composer = await joinFirst(page, irc, channel);

    await composer.fill(`/kick ${operator.nickname} bye`);
    await composer.press("Enter");

    await expect(
      composerNotice(page, `You need to be a channel operator in ${channel}.`),
    ).toBeVisible();
    const members = await showMembers(page, channel);
    await expect(member(members, operator.nickname)).toBeVisible();
    await expect(
      page.locator("[data-system-line]").filter({ hasText: "kicked" }),
    ).toHaveCount(0);
  });

  test("kicking someone who isn't there names them", async ({ page, irc }) => {
    const channel = irc.channelNamed("kick-absent");
    const composer = await joinFirst(page, irc, channel);
    const elsewhere = await irc.peer("elsewhere", []);
    const offline = irc.nickNamed("offline");

    await composer.fill(`/kick ${elsewhere.nickname}`);
    await composer.press("Enter");
    await expect(
      composerNotice(page, `${elsewhere.nickname} isn't in ${channel}.`),
    ).toBeVisible();

    await composer.fill(`/kick ${offline}`);
    await composer.press("Enter");
    await expect(
      composerNotice(page, `${offline} isn't on this network.`),
    ).toBeVisible();
  });

  test("a missing nick and a non-channel conversation explain themselves", async ({
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("kick-usage");
    const composer = await joinFirst(page, irc, channel);
    await composer.fill("/kick");
    await composer.press("Enter");
    await expect(
      composerNotice(page, "That command needs more information."),
    ).toBeVisible();

    const peer = await irc.peer("dmpeer");
    await composer.fill(`/query ${peer.nickname}`);
    await composer.press("Enter");
    const direct = page.getByRole("textbox", {
      name: `Message ${peer.nickname}`,
    });
    await expect(direct).toBeVisible();
    await direct.fill(`/kick ${peer.nickname}`);
    await direct.press("Enter");
    await expect(
      composerNotice(page, "That command only works in a channel."),
    ).toBeVisible();
  });
});
