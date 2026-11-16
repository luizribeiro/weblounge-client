import type { Page } from "@playwright/test";

export function tokenColor(
  page: Page,
  token: `--wl-${string}`,
): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.background = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, token);
}
