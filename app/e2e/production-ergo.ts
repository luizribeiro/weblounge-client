import type { Locator, Page } from "@playwright/test";

export const productionChannel = process.env.WEBLOUNGE_E2E_CHANNEL ?? "#lounge";

export function productionMessageRow(page: Page, text: string): Locator {
  return page.locator("[data-message-row]").filter({
    has: page.getByText(text, { exact: true }),
  });
}

export async function useDedicatedWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
  });
}

export function hasSelfNickColour(element: HTMLElement): boolean {
  const nick = element.querySelector<HTMLElement>('[title="weblounge"]');
  if (nick === null) return false;
  const reference = document.createElement("span");
  reference.style.color = "var(--wl-color-self-nick)";
  document.body.append(reference);
  const expected = getComputedStyle(reference).color;
  reference.remove();
  return getComputedStyle(nick).color === expected;
}
