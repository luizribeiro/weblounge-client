import {
  deliverNativeNotification,
  dispatchShellEvent,
  installIosShellStub,
  nativeCalls,
  queuePushedMessage,
} from "./ios-shell-stub";
import { expect, test } from "./irc-fixture";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
  resetNativeFeelLayoutShift,
} from "./native-feel-audit";
import { expectSettled } from "./settled";

test.describe("the iPhone app's page against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("shows a message the extension queued when its notification is tapped", async ({
    page,
    irc,
  }) => {
    await installIosShellStub(page);
    await page.goto(irc.url());
    await page.getByRole("button", { name: irc.channel }).click();
    await expect(
      page.getByRole("heading", { name: irc.channel }),
    ).toBeVisible();
    const route = new URL(page.url()).pathname;
    const networkLabel = decodeURIComponent(route.split("/")[1] ?? "");
    await page.getByRole("button", { name: "Back to chats" }).click();
    await expectSettled(page);
    const text = `queued by the extension ${irc.id}`;

    await queuePushedMessage(page, {
      schema: 1,
      network_label: networkLabel,
      nickname: irc.account,
      route,
      sender: irc.nickNamed("mel"),
      account: null,
      target: irc.channel,
      msgid: `extension-${irc.id}`,
      time: new Date().toISOString(),
      text,
      kind: "message",
    });
    await dispatchShellEvent(page, {
      name: "weblounge:open-route",
      detail: route,
    });

    await expect(
      page.getByRole("heading", { name: irc.channel }),
    ).toBeVisible();
    await expect(
      page.locator(`[data-message-row][data-message-text="${text}"]`),
    ).toBeVisible();
    const commands = (await nativeCalls(page)).map(({ command }) => command);
    expect(commands).toContain("push_permission");
    expect(commands).not.toContain("request_push_permission");
  });

  test("badges an unread DM and opens it from a notification tap", async ({
    page,
    irc,
  }) => {
    await installIosShellStub(page);
    await installNativeFeelInstrumentation(page);
    await page.goto(irc.url());

    const root = page.locator("#root");
    await expect(root).toHaveAttribute("data-shell", "mobile");
    await expect(root).toHaveAttribute("data-display", "tauri");
    await page.getByRole("button", { name: irc.channel }).click();
    await expect(
      page.getByRole("heading", { name: irc.channel }),
    ).toBeVisible();
    const networkLabel = new URL(page.url()).pathname.split("/")[1];
    await page.getByRole("button", { name: "Back to chats" }).click();
    await expectSettled(page);
    await resetNativeFeelLayoutShift(page);

    const mel = await irc.peer("mel");
    const text = `ios app direct ${irc.id}`;
    const echoed = await mel.privmsgConfirmed(irc.account, text);
    const msgid = /msgid=([^;\s]+)/u.exec(echoed)?.[1] ?? "";
    const directRow = page
      .locator("[data-mobile-chats] [data-buffer-id]")
      .filter({ hasText: mel.nickname });
    await expect(directRow).toBeVisible();
    await expect.poll(async () => lastBadge(await nativeCalls(page))).toBe(1);
    const route = `/${networkLabel}/@${mel.nickname}`;
    await deliverNativeNotification(page, {
      identifier: msgid,
      data: {
        route,
        conversationTag: `${decodeURIComponent(networkLabel)}/${mel.nickname.toLowerCase()}`,
        messageId: msgid,
        messageTime: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    await dispatchShellEvent(page, {
      name: "weblounge:open-route",
      detail: route,
    });

    await expect(
      page.getByRole("heading", { name: mel.nickname }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("list", { name: "Messages" })
        .getByText(text, { exact: true }),
    ).toBeVisible();
    await expectSettled(page, { conversation: mel.nickname });
    await expect.poll(async () => lastBadge(await nativeCalls(page))).toBe(0);
    await expect
      .poll(async () => nativeCalls(page))
      .toContainEqual({
        command: "remove_delivered_notifications",
        request: { identifiers: [msgid] },
      });
    const commands = new Set((await nativeCalls(page)).map((c) => c.command));
    expect(commands).toContain("take_pushed_messages");
    expect(commands).toContain("write_notification_counts");
    await nativeFeelAudit(page);
  });
});

function lastBadge(
  calls: readonly { command: string; request: unknown }[],
): number | undefined {
  const request = calls.findLast(({ command }) => command === "set_badge")
    ?.request as { count: number } | undefined;
  return request?.count;
}
