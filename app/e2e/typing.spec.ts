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
      if (mobile) {
        await emulateStandalone(page);
        await installEngineClock(page);
      } else await sender.privmsgConfirmed(channel, incoming);
      await page.goto("/?irc-password=weblounge-test");
      if (mobile) {
        await expect(page.locator("[data-mobile-chats]")).toBeVisible();
        await page.getByRole("button", { name: channel, exact: true }).click();
        await expect(
          page.getByRole("heading", { name: channel }),
        ).toBeVisible();
        const channelComposer = page.getByRole("textbox", {
          name: `Message ${channel}`,
        });
        const verifiedOpening = `verified typing thread ${Date.now()}`;
        await channelComposer.fill(
          `/query ${sender.nickname} ${verifiedOpening}`,
        );
        await channelComposer.press("Enter");
        await sender.waitForPrivmsg(
          sender.nickname,
          verifiedOpening,
          "weblounge",
        );
        await expect(
          page.getByRole("heading", { name: sender.nickname }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Back to chats" }).click();
        await expect(page.locator("[data-mobile-chats]")).toBeVisible();
        await expect(page.locator("[data-motion]")).toHaveCount(0);
        const echoedIncoming = await sender.privmsgConfirmed(
          "weblounge",
          incoming,
        );
        expectServerTags(echoedIncoming, sender.nickname);
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
        await page.getByRole("button", { name: "Back to chats" }).click();
        await expect(page.locator("[data-mobile-chats]")).toBeVisible();
        await expect(page.locator("[data-motion]")).toHaveCount(0);
        await startEngineClock(page);
        const firstActive = await sender.typingConfirmed("weblounge", "active");
        expectServerTags(firstActive, sender.nickname);
        await advanceEngineClock(page, 3_000);
        const refreshedActive = await sender.typingConfirmed(
          "weblounge",
          "active",
        );
        expectServerTags(refreshedActive, sender.nickname);
        await page
          .getByRole("button", {
            name: new RegExp(`^${sender.nickname}(?:,|$)`, "u"),
          })
          .click();
        await expect(
          page.getByRole("heading", { name: sender.nickname }),
        ).toBeVisible();
        await expect(page.locator("[data-motion]")).toHaveCount(0);
        await expect(indicator).toContainText(`${sender.nickname} is typing…`);
        await expectMobileTypingIndicatorVisible(indicator);
        const activeGeometry = await transcriptEdgeGeometry(incomingRow);
        expectTranscriptClear(activeGeometry, "active typing row");
        expectStableTypingGeometry(emptyGeometry, activeGeometry);
        const done = await sender.typingConfirmed("weblounge", "done");
        expectServerTags(done, sender.nickname);
        await expect(indicator).toHaveText("");
        const reply = `typing edge reply ${Date.now()}`;
        const echoedReply = await sender.privmsgConfirmed("weblounge", reply);
        expectServerTags(echoedReply, sender.nickname);
        await expect(
          conversationRoot.getByText(reply, { exact: true }),
        ).toBeVisible();
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

function expectServerTags(line: string, account: string): void {
  const tagPrefix = line.split(" ", 1)[0] ?? "";
  const tags = new Map(
    tagPrefix
      .replace(/^@/u, "")
      .split(";")
      .map((tag) => {
        const separator = tag.indexOf("=");
        return separator === -1
          ? [tag, ""]
          : [tag.slice(0, separator), tag.slice(separator + 1)];
      }),
  );
  expect(tags.get("account"), line).toBe(account);
  expect(tags.get("time"), line).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u,
  );
}

async function expectMobileTypingIndicatorVisible(
  indicator: Locator,
): Promise<void> {
  await expect(indicator).toBeVisible();
  const visibility = await indicator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const composer = element
      .closest("[data-mobile-chat]")
      ?.querySelector<HTMLElement>("[data-composer]");
    const composerRect = composer?.getBoundingClientRect();
    const clippedBy: string[] = [];
    for (
      let ancestor = element.parentElement;
      ancestor !== null;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor);
      if (
        !/(auto|clip|hidden|scroll)/u.test(
          `${style.overflowX} ${style.overflowY}`,
        )
      )
        continue;
      const ancestorRect = ancestor.getBoundingClientRect();
      if (
        rect.left < ancestorRect.left ||
        rect.right > ancestorRect.right ||
        rect.top < ancestorRect.top ||
        rect.bottom > ancestorRect.bottom
      )
        clippedBy.push(
          ancestor.dataset.mobileChat === "true"
            ? "mobile-chat"
            : ancestor.tagName,
        );
    }
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const previousPointerEvents = element.style.pointerEvents;
    element.style.pointerEvents = "auto";
    const hit = document.elementFromPoint(centerX, centerY);
    element.style.pointerEvents = previousPointerEvents;
    return {
      clippedBy,
      composerTop: composerRect?.top,
      covered: hit !== element && !element.contains(hit),
      hit:
        hit instanceof HTMLElement
          ? {
              className: hit.className,
              data: { ...hit.dataset },
              tagName: hit.tagName,
            }
          : null,
      rect: {
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
      },
      viewport: { height: innerHeight, width: innerWidth },
    };
  });
  const measurement = JSON.stringify(visibility);
  expect(visibility.clippedBy, measurement).toEqual([]);
  expect(visibility.covered, measurement).toBe(false);
  expect(visibility.rect.left, measurement).toBeGreaterThanOrEqual(0);
  expect(visibility.rect.top, measurement).toBeGreaterThanOrEqual(0);
  expect(visibility.rect.right, measurement).toBeLessThanOrEqual(
    visibility.viewport.width,
  );
  expect(visibility.rect.bottom, measurement).toBeLessThanOrEqual(
    visibility.viewport.height,
  );
  expect(visibility.composerTop, measurement).toBeDefined();
  expect(visibility.rect.bottom, measurement).toBeLessThanOrEqual(
    visibility.composerTop as number,
  );
}

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
