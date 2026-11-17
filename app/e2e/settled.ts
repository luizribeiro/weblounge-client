import { expect, type Page } from "@playwright/test";

const inFlight = {
  "screen motion": "[data-motion]",
  "drawer motion": '[data-moving="true"]',
  "connection progress": "[data-connection-progress]",
  "history page loading": '[data-divider-kind="loading"]',
  "keyboard geometry": "#root[data-keyboard-watch]",
  "chats scroll restore": "[data-restoring-scroll]",
  "transcript scroll": "[data-message-list][data-scrolling]",
  "read dwell": "[data-read-dwell]",
} as const;

export interface SettledOptions {
  readonly conversation?: string;
}

interface SettledProbeInput {
  readonly selectors: Readonly<Record<string, string>>;
  readonly title: string | undefined;
}

/** Runs in the page: what is still in flight, after the frames that report it. */
export async function pendingSettle({
  selectors,
  title,
}: SettledProbeInput): Promise<string[]> {
  // A scrollTop write dispatches its scroll event at the next frame, and the transcript marks
  // itself scrolling in the frame after that.
  await nextFrames(2);
  const pending = Object.entries(selectors)
    .filter(([, selector]) => document.querySelector(selector))
    .map(([reason]) => reason);
  if (title === undefined) return pending;
  const shown = [
    ...document.querySelectorAll("[data-conversation-title]"),
  ].some(
    (heading) =>
      heading.textContent?.trim() === title &&
      heading.checkVisibility({ visibilityProperty: true }) &&
      heading.closest("[inert], [aria-hidden='true']") === null,
  );
  return shown ? pending : [...pending, `${title} not shown`];

  function nextFrames(count: number): Promise<void> {
    if (count === 0 || document.hidden) return Promise.resolve();
    return new Promise((resolve) =>
      requestAnimationFrame(() => resolve(nextFrames(count - 1))),
    );
  }
}

export function settleProbeInput(conversation?: string): SettledProbeInput {
  return { selectors: inFlight, title: conversation };
}

export async function expectSettled(
  page: Page,
  { conversation }: SettledOptions = {},
): Promise<void> {
  await expect
    .poll(() => page.evaluate(pendingSettle, settleProbeInput(conversation)), {
      message: "the app is still settling",
    })
    .toEqual([]);
}

// A tap lands on whatever is under it, so tapping Back while the pushed
// screen is still sliding in hits its header instead of the button.
export async function backToChats(
  page: Page,
  conversation: string,
): Promise<void> {
  await expectSettled(page, { conversation });
  await page.getByRole("button", { name: "Back to chats" }).click();
}

export async function backToChatList(
  page: Page,
  conversation: string,
): Promise<void> {
  await backToChats(page, conversation);
  await expect(page.locator("[data-mobile-chats]")).toBeVisible();
  await expectSettled(page);
}
