import { expect, type Page } from "@playwright/test";

const inFlight = {
  "screen motion": "[data-motion]",
  "drawer motion": '[data-moving="true"]',
  "connection progress": "[data-connection-progress]",
  "history page loading": '[data-divider-kind="loading"]',
  "keyboard geometry": "#root[data-keyboard-watch]",
  "chats scroll restore": "[data-restoring-scroll]",
  "transcript scroll": "[data-message-list][data-scrolling]",
} as const;

export interface SettledOptions {
  readonly conversation?: string;
}

export async function expectSettled(
  page: Page,
  { conversation }: SettledOptions = {},
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ selectors, title }) => {
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
          },
          { selectors: inFlight, title: conversation },
        ),
      { message: "the app is still settling" },
    )
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
