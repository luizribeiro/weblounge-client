import type { Page } from "@playwright/test";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { emulateStandalone } from "./mobile-platform";
import { performanceRunCount } from "./performance-runs";
import { expectSettled } from "./settled";

// Trace snapshots run in the page between the tap and its first frame and
// would be billed to the push.
test.use({ trace: "off" });

const cpuThrottle = 4;
const tapFrameBudgetMs = 230;
const senders = 13;
const rounds = 20;

test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CPU throttling needs CDP");
  await emulateStandalone(page);
});

test(
  "a push into a long conversation starts within its tap-frame budget at 4x CPU",
  {
    tag: "@serial",
  },
  async ({ page, irc }, testInfo) => {
    await page.goto(irc.url());
    await expect(page.getByRole("button", { name: irc.channel })).toBeVisible();
    await seedLongConversation(page, irc);
    await expectSettled(page);
    await pushAndReturn(page, irc);
    expect(await page.evaluate(() => document.fonts.status)).toBe("loaded");
    expect(await page.evaluate(installTapFrameProbe)).toBe(true);
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });

    const tapFrames: number[] = [];
    for (let run = 0; run < performanceRunCount; run += 1)
      tapFrames.push(await pushAndReturn(page, irc));
    const median = [...tapFrames].sort((a, b) => a - b)[
      Math.floor(tapFrames.length / 2)
    ];
    await testInfo.attach("push-tap-frames", {
      body: JSON.stringify({ median, tapFrames }),
      contentType: "application/json",
    });

    expect(median).toBeLessThan(tapFrameBudgetMs);
  },
);

async function seedLongConversation(
  page: Page,
  irc: IrcTestAccount,
): Promise<void> {
  const peers = await Promise.all(
    Array.from({ length: senders }, (_, index) => irc.peer(`talk${index}`)),
  );
  for (let round = 0; round < rounds; round += 1)
    await Promise.all(
      peers.map((peer, index) =>
        peer.privmsgConfirmed(irc.channel, conversationLine(round, index)),
      ),
    );
  await expect(page.getByRole("button", { name: irc.channel })).toContainText(
    `${rounds - 1}.`,
  );
}

function conversationLine(round: number, sender: number): string {
  const lines = [
    "has anyone tried the new build on their phone yet",
    "the reconnect backoff seems a little aggressive when the network flaps on cellular, which drops every few minutes on my commute",
    "lol",
    "see https://example.org/issues/12345 for the details",
    "pushing a fix now, should land once CI is green",
  ];
  return `${round}.${sender} ${lines[(round + sender) % lines.length]}`;
}

async function pushAndReturn(page: Page, irc: IrcTestAccount): Promise<number> {
  await page.evaluate(() => (window as TapFrameWindow).tapFrameProbe?.reset());
  await page.getByRole("button", { name: irc.channel }).tap();
  await expectSettled(page, { conversation: irc.channel });
  const tapFrame = await page.evaluate(
    () => (window as TapFrameWindow).tapFrameProbe?.longestTapFrame() ?? 0,
  );
  await page.getByRole("button", { name: "Back to chats" }).tap();
  await expectSettled(page);
  return tapFrame;
}

interface TapFrameProbe {
  reset(): void;
  longestTapFrame(): number;
}

type TapFrameWindow = Window & { tapFrameProbe?: TapFrameProbe };

function installTapFrameProbe(): boolean {
  if (!PerformanceObserver.supportedEntryTypes.includes("long-animation-frame"))
    return false;
  let frames: PerformanceEntry[] = [];
  let tap: number | undefined;
  let slide: number | undefined;
  const observer = new PerformanceObserver((list) => {
    frames.push(...list.getEntries());
  });
  observer.observe({ type: "long-animation-frame" });
  document.addEventListener(
    "pointerdown",
    (event) => {
      tap ??= event.timeStamp;
    },
    { capture: true },
  );
  document.addEventListener(
    "transitionrun",
    (event) => {
      if (event.target instanceof HTMLElement && event.target.dataset.motion)
        slide ??= event.timeStamp;
    },
    { capture: true },
  );
  (window as TapFrameWindow).tapFrameProbe = {
    reset() {
      frames = [];
      tap = undefined;
      slide = undefined;
    },
    longestTapFrame() {
      frames.push(...observer.takeRecords());
      const start = tap;
      const end = slide;
      if (start === undefined || end === undefined)
        throw new Error("the tap or its slide was not observed");
      return Math.max(
        0,
        ...frames
          .filter(
            (frame) =>
              frame.startTime < end && frame.startTime + frame.duration > start,
          )
          .map((frame) => frame.duration),
      );
    },
  };
  return true;
}
