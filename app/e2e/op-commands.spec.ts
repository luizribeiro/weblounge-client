import {
  composerNotice,
  joinFirst,
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
