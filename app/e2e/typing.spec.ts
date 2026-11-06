import { expect, type Locator, test } from "@playwright/test";
import {
  advanceEngineClock,
  installEngineClock,
  startEngineClock,
} from "./engine-clock";
import { IrcClient } from "./irc-client";
import { emulateStandalone } from "./mobile-platform";

const channel = process.env.WEBLOUNGE_E2E_CHANNEL ?? "#weblounge-test";

interface TranscriptEdgeGeometry {
  readonly composerTop: number;
  readonly listBottom: number;
  readonly messageBottom: number;
  readonly typingBottom: number;
  readonly typingTop: number;
}

test.describe("typing indicators", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );

  test("shows and clears incoming channel and direct typing", async ({
    page,
  }) => {
    const peer = await IrcClient.connect(
      "typing-peer",
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    const indicator = page.locator("[data-typing-indicator]");
    try {
      await installEngineClock(page);
      await page.goto("/?irc-password=weblounge-test");
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();

      await peer.typingConfirmed(channel, "active");
      await expect(indicator).toContainText("typing-peer is typing…");
      await peer.typingConfirmed(channel, "done");
      await expect(indicator).toHaveText("");

      await peer.typingConfirmed(channel, "active");
      await expect(indicator).toContainText("typing-peer is typing…");
      const channelMessage = `typing clear ${Date.now()}`;
      await peer.privmsgConfirmed(channel, channelMessage);
      await expect(
        page.getByText(channelMessage, { exact: true }),
      ).toBeVisible();
      await expect(indicator).toHaveText("");

      const directMessage = `open typing direct ${Date.now()}`;
      await peer.privmsgConfirmed("weblounge", directMessage);
      await page
        .getByRole("button", { name: /^typing-peer, 1 unread/u })
        .click();
      await expect(
        page.getByRole("heading", { name: "typing-peer" }),
      ).toBeVisible();
      await peer.typingConfirmed("weblounge", "active");
      await expect(indicator).toContainText("typing-peer is typing…");
      await peer.typingConfirmed("weblounge", "done");
      await expect(indicator).toHaveText("");

      await page.getByRole("button", { name: channel, exact: true }).click();
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();
      await startEngineClock(page);
      await peer.typingConfirmed(channel, "active");
      await expect(indicator).toContainText("typing-peer is typing…");
      await advanceEngineClock(page, 6_001);
      await expect(indicator).toHaveText("");
    } finally {
      peer.close();
    }
  });

  test("keeps the newest transcript line clear of the typing reserve", async ({
    page,
  }, testInfo) => {
    const mobile = testInfo.project.name === "webkit-mobile-typing";
    const typer = await IrcClient.connectIsolated(
      mobile ? "typing-edge-mobile" : "typing-edge-desktop",
      channel,
    );
    const sender = await IrcClient.connectIsolated(
      mobile ? "typing-sender-mobile" : "typing-sender-desktop",
      channel,
    );
    try {
      const incoming = `typing edge incoming ${Date.now()}`;
      if (mobile) await emulateStandalone(page);
      else await sender.privmsgConfirmed(channel, incoming);
      await page.goto("/?irc-password=weblounge-test");
      if (mobile) {
        await expect(page.locator("[data-mobile-chats]")).toBeVisible();
        await sender.privmsgConfirmed("weblounge", incoming);
        await page
          .getByRole("button", {
            name: new RegExp(`^${sender.nickname}, 1 unread`, "u"),
          })
          .click();
      }
      const conversation = mobile ? sender.nickname : channel;
      await expect(
        page.getByRole("heading", { name: conversation }),
      ).toBeVisible();
      if (mobile) await expect(page.locator("[data-motion]")).toHaveCount(0);
      const conversationRoot = mobile
        ? page.locator("[data-mobile-chat]").filter({
            has: page.getByRole("heading", { name: conversation }),
          })
        : page.locator("[data-app-root]");
      const indicator = conversationRoot.locator("[data-typing-indicator]");

      const incomingRow = conversationRoot
        .locator("[data-message-row]")
        .filter({ has: page.getByText(incoming, { exact: true }) });
      await expect(incomingRow).toBeVisible();

      const emptyGeometry = await transcriptEdgeGeometry(incomingRow);
      await expect(indicator).toHaveText("");
      expectTranscriptClear(emptyGeometry, "empty typing row");

      if (mobile) {
        await sender.typingConfirmed("weblounge", "active");
        const activeGeometry = await transcriptEdgeGeometry(incomingRow);
        expectTranscriptClear(activeGeometry, "active typing row");
        expectStableTypingGeometry(emptyGeometry, activeGeometry);
        await sender.typingConfirmed("weblounge", "done");
        await expect(indicator).toHaveText("");
      } else {
        await typer.typingConfirmed(channel, "active");
        await expect(indicator).toContainText(`${typer.nickname} is typing…`);
        const activeGeometry = await transcriptEdgeGeometry(incomingRow);
        expectTranscriptClear(activeGeometry, "active typing row");
        expectStableTypingGeometry(emptyGeometry, activeGeometry);
        await typer.typingConfirmed(channel, "done");
        await expect(indicator).toHaveText("");
      }
      const sent = `typing edge sent ${Date.now()}`;
      const composer = page.getByRole("textbox", {
        name: `Message ${conversation}`,
      });
      await composer.fill(sent);
      await composer.press("Enter");
      const sentRow = conversationRoot
        .locator('[data-message-row][data-delivery="confirmed"]')
        .filter({ has: page.getByText(sent, { exact: true }) });
      await expect(sentRow).toBeVisible();
      expectTranscriptClear(
        await transcriptEdgeGeometry(sentRow),
        "after sending",
      );
    } finally {
      sender.close();
      typer.close();
    }
  });

  test("sends throttled active, paused, and done states", async ({ page }) => {
    const observer = await IrcClient.connect(
      "typing-observer",
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    try {
      await page.goto("/?irc-password=weblounge-test");
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();
      const composer = page.getByRole("textbox", {
        name: `Message ${channel}`,
      });

      await composer.fill("h");
      expect(await observer.waitForNextTyping(channel, "weblounge")).toBe(
        "active",
      );
      await composer.fill("he");
      await composer.fill("hel");
      expect(await observer.waitForNextTyping(channel, "weblounge")).toBe(
        "paused",
      );

      const text = `hello from typing ${Date.now()}`;
      await composer.fill(text);
      expect(await observer.waitForNextTyping(channel, "weblounge")).toBe(
        "active",
      );
      await composer.press("Enter");
      expect(await observer.waitForNextTyping(channel, "weblounge")).toBe(
        "done",
      );
      await observer.waitForPrivmsg(channel, text, "weblounge");
      await expect(page.getByText(text, { exact: true })).toBeVisible();
    } finally {
      observer.close();
    }
  });
});

async function transcriptEdgeGeometry(
  row: Locator,
): Promise<TranscriptEdgeGeometry> {
  let measured: TranscriptEdgeGeometry | undefined;
  await expect
    .poll(async () => {
      measured = await row
        .evaluate((message) => {
          const list = message.closest<HTMLElement>("[data-message-list]");
          const surface = list?.parentElement;
          const typing = surface?.querySelector<HTMLElement>(
            "[data-typing-indicator]",
          );
          const composer =
            surface?.parentElement?.querySelector<HTMLElement>(
              "[data-composer]",
            );
          if (list === null || typing === null || composer === null) return;
          const listRect = list.getBoundingClientRect();
          const messageRect = message.getBoundingClientRect();
          const typingRect = typing.getBoundingClientRect();
          const composerRect = composer.getBoundingClientRect();
          return {
            composerTop: composerRect.top,
            listBottom: listRect.bottom,
            messageBottom: messageRect.bottom,
            typingBottom: typingRect.bottom,
            typingTop: typingRect.top,
          };
        })
        .catch(() => undefined);
      return measured;
    })
    .not.toBeUndefined();
  if (measured === undefined)
    throw new Error("conversation edge geometry is incomplete");
  return measured;
}

function expectTranscriptClear(
  geometry: TranscriptEdgeGeometry,
  state: string,
): void {
  const measurement = `${state}: ${JSON.stringify(geometry)}`;
  expect(geometry.messageBottom, measurement).toBeLessThanOrEqual(
    geometry.typingTop,
  );
  expect(geometry.typingBottom, measurement).toBeLessThanOrEqual(
    geometry.composerTop,
  );
}

function expectStableTypingGeometry(
  empty: TranscriptEdgeGeometry,
  active: TranscriptEdgeGeometry,
): void {
  expect(
    Math.abs(active.messageBottom - empty.messageBottom),
  ).toBeLessThanOrEqual(1);
  expect(Math.abs(active.listBottom - empty.listBottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(active.composerTop - empty.composerTop)).toBeLessThanOrEqual(
    1,
  );
}
