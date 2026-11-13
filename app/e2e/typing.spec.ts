import { expect, type Locator, test } from "@playwright/test";
import {
  advanceEngineClock,
  installEngineClock,
  startEngineClock,
} from "./engine-clock";
import { IrcClient } from "./irc-client";
import { emulateStandalone } from "./mobile-platform";
import { waitForStableGeometry } from "./stable-geometry";

const channel = process.env.WEBLOUNGE_E2E_CHANNEL ?? "#weblounge-test";

interface Box {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

interface TranscriptEdgeGeometry {
  readonly composer: Box;
  readonly composerBorderTopWidth: string;
  readonly composerHeight: number;
  readonly hitElement: string | undefined;
  readonly hitLastTextLine: boolean;
  readonly hitMessageText: string | undefined;
  readonly inputTop: number;
  readonly lastTextLineBottom: number | undefined;
  readonly listBottom: number;
  readonly listClientHeight: number;
  readonly listScrollHeight: number;
  readonly listScrollTop: number;
  readonly messageBottom: number;
  readonly newestRowBottom: number;
  readonly typing: Box;
  readonly typingInComposer: boolean;
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

  test("renders spaces in the composer typing line for one and two typers", async ({
    page,
  }, testInfo) => {
    const mobile = testInfo.project.name === "webkit-mobile-typing";
    const suffix = mobile ? "mobile" : "desktop";
    const run = Date.now().toString(36).slice(-5);
    const typingChannel = `#typing-${suffix[0]}-${run}`;
    const viewer = `typing-viewer-${suffix[0]}-${run}`;
    const seed = await IrcClient.connectIsolated(viewer, typingChannel);
    seed.close();
    await seed.waitForDisconnect();
    const first = await IrcClient.connectIsolated(
      `typing-alexandria-${suffix[0]}-${run}`,
      typingChannel,
    );
    const second = await IrcClient.connectIsolated(
      `typing-bartholomew-${suffix[0]}-${run}`,
      typingChannel,
    );
    const third = await IrcClient.connectIsolated(
      `typing-cordelia-${suffix[0]}-${run}`,
      typingChannel,
    );
    try {
      if (mobile) await emulateStandalone(page);
      const params = new URLSearchParams({
        "irc-account": viewer,
        "irc-autojoin": typingChannel,
        "irc-nickname": viewer,
        "irc-password": `test-${viewer}`,
      });
      await page.goto(`/?${params.toString()}`);
      if (mobile)
        await expect(page.locator("[data-mobile-chats]")).toBeVisible();
      await page
        .getByRole("button", { name: typingChannel, exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: typingChannel }),
      ).toBeVisible();
      const indicator = page.locator("[data-typing-indicator]");

      const typingMessage = `typing colour from ${first.nickname}`;
      await first.privmsgConfirmed(typingChannel, typingMessage);
      await first.typingConfirmed(typingChannel, "active");
      await expect(indicator).toContainText(`${first.nickname} is typing…`);
      const typingNick = indicator.locator(
        `[data-typing-nick="${first.nickname}"]`,
      );
      const typingRow = page.locator(
        `[data-message-row][data-message-text="${typingMessage}"]`,
      );
      const senderNick = typingRow.locator(`[title="${first.nickname}"]`);
      await expect(senderNick).toBeVisible();
      if (!mobile)
        await expectSharedLeftEdge({
          composer: page.getByRole("textbox", {
            name: `Message ${typingChannel}`,
          }),
          time: typingRow.locator("time"),
          typing: indicator.locator("[data-typing-text]"),
        });
      await expect(typingNick).toHaveCSS("font-weight", "650");
      const senderColor = await senderNick.evaluate(
        (element) => getComputedStyle(element).color,
      );
      await expect(typingNick).toHaveCSS("color", senderColor);
      const singleSpacing = await visibleTypingSpaces(indicator);

      await second.typingConfirmed(typingChannel, "active");
      await expect(indicator).toContainText(
        `${first.nickname} and ${second.nickname} are typing…`,
      );
      const pairSpacing = await visibleTypingSpaces(indicator);
      const truncation = await typingTruncation(indicator);

      await third.typingConfirmed(typingChannel, "active");
      await expect(indicator).toHaveText("several people are typing…");
      await expect(indicator.locator("[data-typing-nick]")).toHaveCount(0);

      expect.soft(singleSpacing, "space before 'is typing'").toEqual([1]);
      expect
        .soft(pairSpacing, "spaces around 'and' and before 'are typing'")
        .toEqual([1, 1, 1]);
      expect(truncation).toMatchObject({
        clippedWithinRow: true,
        overflow: "hidden",
        whiteSpace: "nowrap",
      });
      if (mobile) expect(truncation.hasOverflow).toBe(true);
    } finally {
      first.close();
      second.close();
      third.close();
    }
  });

  test("keeps the transcript against the composer while the typing line changes", async ({
    page,
  }, testInfo) => {
    const mobile = testInfo.project.name === "webkit-mobile-typing";
    const run = Date.now().toString(36).slice(-5);
    const typer = await IrcClient.connectIsolated(
      `typing-edge-${mobile ? "mobile" : "desktop"}-${run}`,
      channel,
    );
    const sender = await IrcClient.connectIsolated(
      `typing-sender-${mobile ? "mobile" : "desktop"}-${run}`,
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
      await expect(page.locator("[data-initial-splash]")).toHaveCount(0);
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

      await expect(indicator).toHaveText("");
      const emptyGeometry = await transcriptEdgeGeometry(
        conversationRoot,
        incomingRow,
      );
      expectTranscriptMeetsComposer(emptyGeometry, "nobody typing");
      expectNewestRowAgainstComposer(emptyGeometry, "nobody typing");

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
        await expectTypingLineChangeKeepsGeometry(
          conversationRoot,
          incomingRow,
          emptyGeometry,
        );
        const done = await sender.typingConfirmed("weblounge", "done");
        expectServerTags(done, sender.nickname);
        await expect(indicator).toHaveText("");
        expectStableTypingGeometry(
          emptyGeometry,
          await transcriptEdgeGeometry(conversationRoot, incomingRow),
          "after typing stops",
        );
        const reply = `typing edge reply ${Date.now()}`;
        const echoedReply = await sender.privmsgConfirmed("weblounge", reply);
        expectServerTags(echoedReply, sender.nickname);
        await expect(
          conversationRoot.getByText(reply, { exact: true }),
        ).toBeVisible();
      } else {
        await typer.typingConfirmed(channel, "active");
        await expect(indicator).toContainText(`${typer.nickname} is typing…`);
        await expectTypingLineChangeKeepsGeometry(
          conversationRoot,
          incomingRow,
          emptyGeometry,
        );
        await typer.typingConfirmed(channel, "done");
        await expect(indicator).toHaveText("");
        expectStableTypingGeometry(
          emptyGeometry,
          await transcriptEdgeGeometry(conversationRoot, incomingRow),
          "after typing stops",
        );
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
      expectTranscriptMeetsComposer(
        await transcriptEdgeGeometry(conversationRoot, sentRow),
        "after sending",
      );
    } finally {
      sender.close();
      typer.close();
    }
  });

  test("keeps a long transcript against the composer typing line", async ({
    page,
  }, testInfo) => {
    const mobile = testInfo.project.name === "webkit-mobile-typing";
    const suffix = `${mobile ? "m" : "d"}${Date.now().toString().slice(-6)}`;
    const sender = await IrcClient.connect(
      `typing-long-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      channel,
    );
    try {
      for (let index = 0; index < 12; index += 1)
        await sender.privmsgConfirmed(
          channel,
          `typing long seed ${suffix} ${index} ${"wrapped history ".repeat(20)}`,
        );
      const opening = `typing long opening ${suffix}`;
      await sender.privmsgConfirmed(channel, opening);

      if (mobile) await emulateStandalone(page);
      await page.goto("/?irc-password=weblounge-test");
      if (mobile) {
        await expect(page.locator("[data-mobile-chats]")).toBeVisible();
        await page
          .getByRole("button", {
            name: new RegExp(`^${channel}(?:,|$)`, "u"),
          })
          .click();
      }
      await expect(page.getByRole("heading", { name: channel })).toBeVisible();
      await expect(page.locator("[data-initial-splash]")).toHaveCount(0);

      const root = mobile
        ? page.locator("[data-mobile-chat]").filter({
            has: page.getByRole("heading", { name: channel }),
          })
        : page.locator("[data-app-root]");
      const composer = root.getByRole("textbox", {
        name: `Message ${channel}`,
      });

      await expectNewestRowClear(root, opening, "after opening long history");

      const version = await page.evaluate(() => window.weblounge.version);
      await composer.fill("/version");
      await composer.press("Enter");
      await expectNewestRowClear(root, version, "after /version");

      const incoming = `typing long incoming ${suffix}`;
      await sender.privmsgConfirmed(channel, incoming);
      await expectNewestRowClear(root, incoming, "after incoming message");

      const sent = `typing long sent ${suffix}`;
      await composer.fill(sent);
      await composer.press("Enter");
      const sentRow = root
        .locator('[data-message-row][data-delivery="confirmed"]')
        .filter({ has: page.getByText(sent, { exact: true }) });
      await expect(sentRow).toBeVisible();
      const sentGeometry = await transcriptEdgeGeometry(root, sentRow);
      expectLongTranscript(sentGeometry, "after sending in long history");
      expectTranscriptMeetsComposer(
        sentGeometry,
        "after sending in long history",
        true,
      );
    } finally {
      sender.close();
    }
  });

  test("keeps unread rows above the composer typing line when opening at New", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "webkit-mobile-typing",
      "covers the iPhone channel-opening path",
    );
    const suffix = Date.now().toString(36);
    const unreadChannel = `#typing-unread-${suffix}`;
    const sender = await IrcClient.connect(
      `typing-unread-${suffix}`,
      "weblounge-bot",
      "weblounge-bot-test",
      unreadChannel,
    );
    try {
      await emulateStandalone(page);
      await page.goto("/?irc-password=weblounge-test");
      await page.getByRole("button", { name: "#weblounge-test" }).click();
      const defaultComposer = page.getByRole("textbox", {
        name: "Message #weblounge-test",
      });
      await defaultComposer.fill(`/join ${unreadChannel}`);
      await defaultComposer.press("Enter");
      await expect(
        page.getByRole("heading", { name: unreadChannel }),
      ).toBeVisible();
      await expect(page.locator("[data-initial-splash]")).toHaveCount(0);

      for (let index = 0; index < 12; index += 1)
        await sender.privmsgConfirmed(
          unreadChannel,
          `typing unread history ${suffix} ${index} ${"wrapped history ".repeat(20)}`,
        );
      const historyEnd = `typing unread history end ${suffix}`;
      await sender.privmsgConfirmed(unreadChannel, historyEnd);
      await expect(page.getByText(historyEnd, { exact: true })).toBeVisible();

      const row = page
        .locator("[data-buffer-id]")
        .filter({ hasText: unreadChannel })
        .first();
      await expect(row).toHaveAttribute("aria-label", unreadChannel);
      await page.getByRole("button", { name: "Back to chats" }).click();
      await expect(page.locator("[data-mobile-chats]")).toBeVisible();

      const unread = Array.from(
        { length: 3 },
        (_, index) => `typing unread ${suffix} ${index + 1}`,
      );
      for (const text of unread)
        await sender.privmsgConfirmed(unreadChannel, text);
      await expect(row).toHaveAttribute(
        "aria-label",
        `${unreadChannel}, 3 unread`,
      );
      await row.click();

      const root = page.locator("[data-mobile-chat]").filter({
        has: page.getByRole("heading", { name: unreadChannel }),
      });
      await expect(root.locator("[data-new-line]")).toBeVisible();
      await expectNewestRowClear(
        root,
        unread.at(-1) ?? "",
        "after opening at New",
      );
    } finally {
      sender.close();
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

async function expectSharedLeftEdge(
  elements: Readonly<Record<string, Locator>>,
): Promise<void> {
  for (const element of Object.values(elements))
    await waitForStableGeometry(element);
  const edges = Object.fromEntries(
    await Promise.all(
      Object.entries(elements).map(async ([name, element]) => [
        name,
        await element.evaluate((node) => node.getBoundingClientRect().left),
      ]),
    ),
  ) as Record<string, number>;
  const values = Object.values(edges);
  expect(
    Math.max(...values) - Math.min(...values),
    `left edges ${JSON.stringify(edges)}`,
  ).toBeLessThanOrEqual(0.5);
}

async function visibleTypingSpaces(indicator: Locator): Promise<number[]> {
  return indicator.evaluate((root) => {
    const nicks = Array.from(
      root.querySelectorAll<HTMLElement>("[data-typing-nick]"),
    );
    const wordRect = (word: string): DOMRect => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (
        let node = walker.nextNode();
        node !== null;
        node = walker.nextNode()
      ) {
        if (node.parentElement?.closest("[data-typing-nick]")) continue;
        const offset = node.textContent?.indexOf(word) ?? -1;
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + word.length);
        return range.getBoundingClientRect();
      }
      throw new Error(`Typing word not found: ${word}`);
    };
    const hasGap = (gap: number): number => Number(gap > 1);

    if (nicks.length === 1) {
      return [
        hasGap(
          wordRect("is typing").left - nicks[0].getBoundingClientRect().right,
        ),
      ];
    }
    if (nicks.length === 2) {
      const firstNick = nicks[0].getBoundingClientRect();
      const conjunction = wordRect("and");
      const secondNick = nicks[1].getBoundingClientRect();
      const predicate = wordRect("are typing");
      return [
        hasGap(conjunction.left - firstNick.right),
        hasGap(secondNick.left - conjunction.right),
        hasGap(predicate.left - secondNick.right),
      ];
    }
    throw new Error(
      `Expected one or two typing nicks, received ${nicks.length}`,
    );
  });
}

async function typingTruncation(indicator: Locator): Promise<{
  readonly clippedWithinRow: boolean;
  readonly hasOverflow: boolean;
  readonly overflow: string;
  readonly whiteSpace: string;
}> {
  return indicator.evaluate((root) => {
    const sentence = root.querySelector<HTMLElement>("[data-typing-text]");
    if (sentence === null) throw new Error("Typing sentence is missing");
    const rowRect = root.getBoundingClientRect();
    const sentenceRect = sentence.getBoundingClientRect();
    const style = getComputedStyle(sentence);
    return {
      clippedWithinRow: sentenceRect.right <= rowRect.right + 1,
      hasOverflow: sentence.scrollWidth > sentence.clientWidth,
      overflow: style.overflowX,
      whiteSpace: style.whiteSpace,
    };
  });
}

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
}

const edgeGeometrySelectors =
  "[data-message-list], [data-message-row], [data-typing-indicator], [data-composer]";

async function transcriptEdgeGeometry(
  root: Locator,
  row: Locator,
): Promise<TranscriptEdgeGeometry> {
  await waitForStableGeometry(root, edgeGeometrySelectors);
  let measured: TranscriptEdgeGeometry | undefined;
  await expect
    .poll(async () => {
      measured = await row
        .evaluate((message) => {
          const list = message.closest<HTMLElement>("[data-message-list]");
          const conversation = list?.parentElement?.parentElement;
          const composer =
            conversation?.querySelector<HTMLElement>("[data-composer]") ?? null;
          const typing =
            conversation?.querySelector<HTMLElement>(
              "[data-typing-indicator]",
            ) ?? null;
          const input = composer?.querySelector("textarea") ?? null;
          if (
            list === null ||
            typing === null ||
            composer === null ||
            input === null
          )
            return;
          const box = (rect: DOMRect) => ({
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            top: rect.top,
          });
          const listRect = list.getBoundingClientRect();
          const messageRect = message.getBoundingClientRect();
          const composerRect = composer.getBoundingClientRect();
          const composerStyle = getComputedStyle(composer);
          const selectable =
            message.querySelector<HTMLElement>("[data-selectable]");
          const walker =
            selectable === null
              ? undefined
              : document.createTreeWalker(selectable, NodeFilter.SHOW_TEXT);
          let textNode: Text | undefined;
          for (
            let node = walker?.nextNode();
            node !== null && node !== undefined;
            node = walker?.nextNode()
          ) {
            if (node.textContent?.trim() !== "") textNode = node as Text;
          }
          const range = textNode === undefined ? undefined : new Range();
          range?.selectNodeContents(textNode);
          const lineRect = [...(range?.getClientRects() ?? [])]
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .at(-1);
          const hit =
            lineRect === undefined
              ? null
              : document.elementFromPoint(
                  lineRect.left + Math.min(lineRect.width / 2, 4),
                  lineRect.bottom - 1,
                );
          return {
            composer: box(composerRect),
            composerBorderTopWidth: composerStyle.borderTopWidth,
            composerHeight: composerRect.height,
            hitElement:
              hit instanceof Element ? hit.tagName.toLowerCase() : undefined,
            hitLastTextLine:
              hit instanceof Element &&
              hit.closest("[data-message-row]") === message,
            hitMessageText:
              hit instanceof Element
                ? hit.closest<HTMLElement>("[data-message-row]")?.dataset
                    .messageText
                : undefined,
            inputTop: input.getBoundingClientRect().top,
            lastTextLineBottom: lineRect?.bottom,
            listBottom: listRect.bottom,
            listClientHeight: list.clientHeight,
            listScrollHeight: list.scrollHeight,
            listScrollTop: list.scrollTop,
            messageBottom: messageRect.bottom,
            newestRowBottom: Math.max(
              ...[...list.querySelectorAll("li[data-index]")].map(
                (virtualRow) => virtualRow.getBoundingClientRect().bottom,
              ),
            ),
            typing: box(typing.getBoundingClientRect()),
            typingInComposer: composer.contains(typing),
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

function expectTranscriptMeetsComposer(
  geometry: TranscriptEdgeGeometry,
  state: string,
  soft = false,
): void {
  const measurement = `${state}: ${JSON.stringify(geometry)}`;
  const check = soft ? expect.soft : expect;
  check(
    Math.abs(geometry.composer.top - geometry.listBottom),
    `transcript runs to the composer, ${measurement}`,
  ).toBeLessThanOrEqual(1);
  check(
    geometry.composerBorderTopWidth,
    `no line on the composer's top edge, ${measurement}`,
  ).toBe("0px");
  check(geometry.lastTextLineBottom, measurement).toBeDefined();
  // WebKit can place the row's padding box a fractional pixel beyond the
  // scroller, where overflow clips it; the rendered text must stay inside.
  check(geometry.lastTextLineBottom as number, measurement).toBeLessThanOrEqual(
    geometry.listBottom,
  );
  check(geometry.hitLastTextLine, measurement).toBe(true);
  expectTypingLineInComposer(geometry, state, soft);
}

function expectTypingLineInComposer(
  geometry: TranscriptEdgeGeometry,
  state: string,
  soft: boolean,
): void {
  const measurement = `typing line inside the composer, ${state}: ${JSON.stringify(geometry)}`;
  const check = soft ? expect.soft : expect;
  check(geometry.typingInComposer, measurement).toBe(true);
  check(geometry.typing.top, measurement).toBeGreaterThanOrEqual(
    geometry.composer.top,
  );
  check(geometry.typing.bottom, measurement).toBeLessThanOrEqual(
    geometry.inputTop,
  );
  check(geometry.typing.left, measurement).toBeGreaterThanOrEqual(
    geometry.composer.left,
  );
  check(geometry.typing.right, measurement).toBeLessThanOrEqual(
    geometry.composer.right,
  );
}

function expectNewestRowAgainstComposer(
  geometry: TranscriptEdgeGeometry,
  state: string,
  soft = false,
): void {
  const check = soft ? expect.soft : expect;
  check(
    Math.abs(geometry.composer.top - geometry.newestRowBottom),
    `newest row meets the composer, ${state}: ${JSON.stringify(geometry)}`,
  ).toBeLessThanOrEqual(1);
}

async function expectTypingLineChangeKeepsGeometry(
  root: Locator,
  row: Locator,
  idle: TranscriptEdgeGeometry,
): Promise<void> {
  const active = await transcriptEdgeGeometry(root, row);
  expectTranscriptMeetsComposer(active, "while typing");
  expectStableTypingGeometry(idle, active, "while typing");
}

async function expectNewestRowClear(
  root: Locator,
  text: string,
  state: string,
): Promise<void> {
  const row = root.locator("[data-message-row]", { hasText: text });
  await expect(row).toBeVisible();
  const geometry = await transcriptEdgeGeometry(root, row);
  expectLongTranscript(geometry, state);
  expectTranscriptMeetsComposer(geometry, state, true);
  expectNewestRowAgainstComposer(geometry, state, true);
}

function expectLongTranscript(
  geometry: TranscriptEdgeGeometry,
  state: string,
): void {
  expect(
    geometry.listScrollHeight,
    `${state}: ${JSON.stringify(geometry)}`,
  ).toBeGreaterThan(geometry.listClientHeight);
}

function expectStableTypingGeometry(
  idle: TranscriptEdgeGeometry,
  current: TranscriptEdgeGeometry,
  state: string,
): void {
  const measurement = `${state}: idle ${JSON.stringify(idle)}, now ${JSON.stringify(current)}`;
  for (const [name, read] of [
    ["newest row bottom", (geometry) => geometry.messageBottom],
    ["transcript bottom", (geometry) => geometry.listBottom],
    ["transcript scroll position", (geometry) => geometry.listScrollTop],
    ["composer top", (geometry) => geometry.composer.top],
    ["composer height", (geometry) => geometry.composerHeight],
  ] as const satisfies readonly (readonly [
    string,
    (geometry: TranscriptEdgeGeometry) => number,
  ])[])
    expect(
      Math.abs(read(current) - read(idle)),
      `${name} ${measurement}`,
    ).toBeLessThanOrEqual(1);
}
