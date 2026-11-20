import {
  composerNotice,
  joinFirst,
  member,
  memberPrefix,
  showMembers,
  submit,
  systemLine,
} from "./channel-commands";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
} from "./native-feel-audit";

test.describe("channel operator commands against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.use({ viewport: { width: 1280, height: 800 } });

  test("/op completes the nick and gives the member the op badge", async ({
    page,
    irc,
  }) => {
    await installNativeFeelInstrumentation(page);
    const channel = irc.channelNamed("op");
    const composer = await joinFirst(page, irc, channel);
    const peer = await irc.peer("helper", [channel]);
    const members = await showMembers(page, channel);
    await expect(memberPrefix(members, peer.nickname)).toHaveText("");

    await composer.pressSequentially(`/op ${peer.nickname.slice(0, 5)}`);
    await expect(page.locator('[data-command-usage="op"]')).toHaveText(
      "/op <nicks>",
    );
    await expect(
      page.getByRole("option", { name: new RegExp(peer.nickname, "u") }),
    ).toBeVisible();
    await composer.press("Enter");
    await expect(composer).toHaveValue(`/op ${peer.nickname} `);
    await composer.press("Enter");

    await expect(memberPrefix(members, peer.nickname)).toHaveText("@");
    await expect(
      systemLine(page, `You gave op to ${peer.nickname}`),
    ).toBeVisible();
    await expect(composer).toHaveValue("");
    await nativeFeelAudit(page);
  });

  test("/deop takes the op badge away", async ({ page, irc }) => {
    const channel = irc.channelNamed("deop");
    const composer = await joinFirst(page, irc, channel);
    const peer = await irc.peer("demoted", [channel]);
    const members = await showMembers(page, channel);
    await submit(composer, `/op ${peer.nickname}`);
    await expect(memberPrefix(members, peer.nickname)).toHaveText("@");

    await submit(composer, `/deop ${peer.nickname}`);

    await expect(memberPrefix(members, peer.nickname)).toHaveText("");
    await expect(
      systemLine(page, `took op from ${peer.nickname}`),
    ).toBeVisible();
  });

  test("/voice gives the member the voice badge", async ({ page, irc }) => {
    const channel = irc.channelNamed("voice");
    const composer = await joinFirst(page, irc, channel);
    const peer = await irc.peer("speaker", [channel]);
    const members = await showMembers(page, channel);

    await submit(composer, `/voice ${peer.nickname}`);

    await expect(memberPrefix(members, peer.nickname)).toHaveText("+");
    await expect(
      systemLine(page, `gave voice to ${peer.nickname}`),
    ).toBeVisible();
  });

  test("/devoice takes the voice badge away", async ({ page, irc }) => {
    const channel = irc.channelNamed("devoice");
    const composer = await joinFirst(page, irc, channel);
    const peer = await irc.peer("quieted", [channel]);
    const members = await showMembers(page, channel);
    await submit(composer, `/voice ${peer.nickname}`);
    await expect(memberPrefix(members, peer.nickname)).toHaveText("+");

    await submit(composer, `/devoice ${peer.nickname}`);

    await expect(memberPrefix(members, peer.nickname)).toHaveText("");
    await expect(
      systemLine(page, `took voice from ${peer.nickname}`),
    ).toBeVisible();
  });

  test("/ban bans a member by host and a typed mask as written", async ({
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("ban");
    const composer = await joinFirst(page, irc, channel);
    const peer = await irc.peer("banned", [channel]);
    await showMembers(page, channel);

    await submit(composer, `/ban ${peer.nickname}`);
    await expect(systemLine(page, "You banned *!*@")).toBeVisible();

    await submit(composer, "/ban *!*@spam.example");
    await expect(systemLine(page, "banned *!*@spam.example")).toBeVisible();
  });

  test("/unban lifts the ban /ban set on a member", async ({ page, irc }) => {
    const channel = irc.channelNamed("unban");
    const composer = await joinFirst(page, irc, channel);
    const peer = await irc.peer("pardoned", [channel]);
    await showMembers(page, channel);
    await submit(composer, `/ban ${peer.nickname}`);
    await expect(systemLine(page, "You banned *!*@")).toBeVisible();

    await submit(composer, `/unban ${peer.nickname}`);

    await expect(systemLine(page, "lifted the ban on *!*@")).toBeVisible();
  });

  test("/kb bans and then kicks the member", async ({ page, irc }) => {
    const channel = irc.channelNamed("kickban");
    const composer = await joinFirst(page, irc, channel);
    const peer = await irc.peer("spammer", [channel]);
    const members = await showMembers(page, channel);
    await expect(member(members, peer.nickname)).toBeVisible();

    await submit(composer, `/kb ${peer.nickname} link spam`);

    await expect(systemLine(page, "You banned *!*@")).toBeVisible();
    await expect(
      systemLine(page, `You kicked ${peer.nickname}`),
    ).toHaveAccessibleName(`You kicked ${peer.nickname}: “link spam”`);
    await expect(member(members, peer.nickname)).toHaveCount(0);
  });

  test("/invite confirms, and names someone already there", async ({
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("invite");
    const composer = await joinFirst(page, irc, channel);
    const guest = await irc.peer("invitee", []);
    const regular = await irc.peer("regular", [channel]);

    await submit(composer, `/invite ${guest.nickname}`);
    await expect(
      page.getByText(`Invited ${guest.nickname} to ${channel}.`),
    ).toBeVisible();

    await submit(composer, `/invite ${regular.nickname}`);
    await expect(
      composerNotice(page, `${regular.nickname} is already in ${channel}.`),
    ).toBeVisible();
  });

  test("someone else's invite shows in the channel", async ({ page, irc }) => {
    const channel = irc.channelNamed("invited");
    await joinFirst(page, irc, channel);
    const host = await irc.peer("host", [channel]);
    const guest = await irc.peer("visitor", []);

    await host.invite(guest.nickname, channel);

    await expect(
      systemLine(page, `${host.nickname} invited ${guest.nickname}`),
    ).toBeVisible();
  });

  test("/mode sets a mode, shows the modes and names an unknown one", async ({
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("mode");
    const composer = await joinFirst(page, irc, channel);

    await submit(composer, "/mode +m");
    await expect(
      systemLine(page, "You made the channel moderated"),
    ).toBeVisible();

    await submit(composer, "/mode");
    await expect(page.getByText(`${channel} modes: +`)).toContainText("m");

    await submit(composer, "/mode +Z");
    await expect(
      composerNotice(page, "The server doesn't support that mode."),
    ).toBeVisible();
  });

  test("each command without its nick asks for more information", async ({
    page,
    irc,
  }) => {
    const channel = irc.channelNamed("op-usage");
    const composer = await joinFirst(page, irc, channel);
    for (const command of [
      "/op",
      "/deop",
      "/voice",
      "/devoice",
      "/ban",
      "/unban",
      "/kick",
      "/kickban",
      "/invite",
    ]) {
      await submit(composer, command);
      await expect(
        composerNotice(page, "That command needs more information."),
      ).toBeVisible();
      await expect(composer).toHaveValue(command);
    }
  });

  test("a non-op gets a readable refusal", async ({ page, irc }) => {
    const channel = irc.channelNamed("op-peer");
    const operator = await irc.peer("chanop", [channel]);
    const composer = await joinFirst(page, irc, channel);

    await submit(composer, `/op ${irc.account}`);

    await expect(
      composerNotice(page, `You need to be a channel operator in ${channel}.`),
    ).toBeVisible();
    const members = await showMembers(page, channel);
    await expect(memberPrefix(members, operator.nickname)).toHaveText("@");
    await expect(memberPrefix(members, irc.account)).toHaveText("");
  });
});
