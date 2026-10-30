import { expect, test } from "@playwright/test";

interface InstallManifest {
  background_color: string;
  display: string;
  icons: Array<{
    purpose?: string;
    sizes: string;
    src: string;
    type: string;
  }>;
  name: string;
  scope: string;
  short_name: string;
  start_url: string;
  theme_color: string;
}

test("publishes self-hosted install metadata", async ({ page, request }) => {
  await page.goto("/");

  await expect(
    page.locator('meta[name="apple-mobile-web-app-title"]'),
  ).toHaveAttribute("content", "weblounge");
  await expect(
    page.locator('meta[name="apple-mobile-web-app-capable"]'),
  ).toHaveAttribute("content", "yes");
  await expect(
    page.locator('meta[name="mobile-web-app-capable"]'),
  ).toHaveAttribute("content", "yes");

  const linkedAssets = await page
    .locator('link[rel="icon"], link[rel="apple-touch-icon"]')
    .evaluateAll((links) =>
      links.map((link) => ({
        href: (link as HTMLLinkElement).href,
        type: (link as HTMLLinkElement).type,
      })),
    );
  expect(linkedAssets).toHaveLength(3);
  for (const asset of linkedAssets) {
    const response = await request.get(asset.href);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain(asset.type);
  }

  const manifestHref = await page
    .locator('link[rel="manifest"]')
    .getAttribute("href");
  expect(manifestHref).not.toBeNull();
  const response = await request.get(manifestHref ?? "");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain(
    "application/manifest+json",
  );
  const manifest = (await response.json()) as InstallManifest;
  expect(manifest).toMatchObject({
    background_color: "#efe8d8",
    display: "standalone",
    name: "weblounge",
    scope: "/",
    short_name: "weblounge",
    start_url: "/",
    theme_color: "#15231c",
  });
  expect(manifest.icons).toEqual([
    {
      sizes: "192x192",
      src: "/icons/icon-192.png",
      type: "image/png",
    },
    {
      sizes: "512x512",
      src: "/icons/icon-512.png",
      type: "image/png",
    },
    {
      purpose: "maskable",
      sizes: "192x192",
      src: "/icons/icon-maskable-192.png",
      type: "image/png",
    },
    {
      purpose: "maskable",
      sizes: "512x512",
      src: "/icons/icon-maskable-512.png",
      type: "image/png",
    },
  ]);
  for (const icon of manifest.icons) {
    const iconResponse = await request.get(icon.src);
    expect(iconResponse.ok()).toBe(true);
    expect(iconResponse.headers()["content-type"]).toContain(icon.type);
  }
});
