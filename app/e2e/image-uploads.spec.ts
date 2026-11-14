import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { E2E_FILEHOST_ORIGIN, E2E_FOREIGN_FILEHOST_ORIGIN } from "../csp";
import { screenshotWithInter } from "./inter-font";
import { IrcClient } from "./irc-client";
import {
  installNativeFeelInstrumentation,
  nativeFeelAudit,
  resetNativeFeelLayoutShift,
} from "./native-feel-audit";

const screenshots =
  process.env.WEBLOUNGE_UPLOAD_SCREENSHOTS ??
  path.join(process.cwd(), "e2e", "screenshots", "image-uploads");
const forwarder =
  process.env.WEBLOUNGE_E2E_FORWARDER_URL ?? "http://127.0.0.1:8091";

interface RecordedUpload {
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly disposition: string | null;
  readonly size: number;
  readonly body: string | null;
}

interface PastedImage {
  readonly width: number;
  readonly height: number;
  readonly noise?: boolean;
  readonly type?: "image/png" | "image/jpeg";
  readonly withGpsExif?: boolean;
  readonly text?: string;
}

test.describe("image uploads against local Ergo", () => {
  test.skip(
    process.env.WEBLOUNGE_E2E_ERGO !== "1",
    "requires the flake's local Ergo fixture",
  );
  test.use({ ignoreHTTPSErrors: true });

  test.beforeEach(async ({ page }) => {
    await control(page.request, "reset");
    await clearTextRewrites();
  });
  test.afterEach(async () => clearTextRewrites());

  test("pastes, uploads with progress on Enter and sends caption and URL", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "the phone layout has its own test");
    await page.setViewportSize({ width: 1280, height: 800 });
    await withDirectPeer(page, "send", async (peer, composer) => {
      await pasteImage(composer, { width: 1000, height: 1000, noise: true });
      const chip = page.locator("[data-attachment-chip]");
      await expect(chip).toHaveAttribute("data-state", "ready");
      await expect(chip).toContainText(/^Image · \d+\.\d MB/u);
      await expectThumbnailLoaded(chip);
      await expect(composer).toHaveValue("");
      expect(await uploads(page.request)).toEqual([]);
      await captureThemes(page, "desktop-chip");

      const key = `send${Date.now().toString(36)}`;
      await control(page.request, "hold", { key });
      await composer.fill("look at this");
      const sendStarted = await now(page);
      await composer.press("Enter");
      await approveUpload(page);
      await expect(chip).toHaveAttribute("data-state", "uploading");
      await expect(chip).toHaveAttribute("aria-busy", "true");
      await expect(
        page.locator("[data-composer-send][data-busy='true']").last(),
      ).toBeVisible();
      await expect.poll(async () => progressOf(chip)).toBeGreaterThan(0.4);
      await captureThemes(page, "desktop-uploading");

      const release = await page.request.get(
        `${E2E_FILEHOST_ORIGIN}/release/${key}`,
      );
      expect(release.ok()).toBe(true);
      const received = await peer.waitForPrivmsg(
        peer.nickname,
        `look at this ${E2E_FILEHOST_ORIGIN}/`,
        "weblounge",
      );
      const url = /(https:\/\/\S+)/u.exec(received)?.[1] ?? "";
      await expect(chip).toHaveCount(0);
      await expect(composer).toHaveValue("");
      await expect(composer).toBeFocused();
      const slot = page
        .locator("[data-message-row]")
        .filter({ hasText: url })
        .locator("[data-inline-image]");
      await expect(slot).toHaveAttribute("data-inline-image", "loaded");

      const [upload] = await uploads(page.request);
      expect(upload?.authorization).toBe(
        `Basic ${Buffer.from("weblounge:weblounge-test").toString("base64")}`,
      );
      expect(upload?.contentType).toBe("image/png");
      expect(upload?.disposition).toBe("inline; filename*=UTF-8''image.png");
      await expectOnlyComposerShifts(page, sendStarted);
      await nativeFeelAudit(page);
    });
  });

  test("strips GPS EXIF from a pasted JPEG and sends a URL alone", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "covered on desktop");
    await withDirectPeer(page, "exif", async (peer, composer) => {
      await pasteImage(composer, {
        width: 64,
        height: 48,
        type: "image/jpeg",
        withGpsExif: true,
      });
      await composer.press("Enter");
      await approveUpload(page);
      await peer.waitForPrivmsg(
        peer.nickname,
        `${E2E_FILEHOST_ORIGIN}/`,
        "weblounge",
      );
      const [upload] = await uploads(page.request);
      const body = Buffer.from(upload?.body ?? "", "base64");
      expect(body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(body.includes(Buffer.from("GPS-37.7749N"))).toBe(false);
      expect(body.includes(Buffer.from("Exif\0\0MM"))).toBe(true);
      expect(upload?.contentType).toBe("image/jpeg");
    });
  });

  test("removes the attachment with × and with Escape", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "covered on desktop");
    await withDirectPeer(page, "remove", async (_peer, composer) => {
      const chip = page.locator("[data-attachment-chip]");
      await pasteImage(composer, { width: 120, height: 80 });
      await page.getByRole("button", { name: "Remove image" }).click();
      await expect(chip).toHaveCount(0);
      await expect(composer).toBeFocused();

      await pasteImage(composer, { width: 120, height: 80 });
      await composer.fill("kept");
      await composer.press("Escape");
      await expect(chip).toHaveCount(1);
      await composer.fill("");
      await composer.press("Escape");
      await expect(chip).toHaveCount(0);
      expect(await uploads(page.request)).toEqual([]);
    });
  });

  test("lets copied text paste through beside the image", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "covered on desktop");
    await withDirectPeer(page, "text", async (_peer, composer) => {
      const prevented = await pasteImage(composer, {
        width: 40,
        height: 40,
        text: "copied caption",
      });
      expect(prevented).toBe(false);
      await expect(page.locator("[data-attachment-chip]")).toHaveCount(1);
    });
  });

  test("refuses to upload while offline and keeps the image", async ({
    page,
    context,
    isMobile,
  }) => {
    test.skip(isMobile, "covered on desktop");
    await withDirectPeer(page, "offline", async (_peer, composer) => {
      await pasteImage(composer, { width: 120, height: 80 });
      await context.setOffline(true);
      await expect(
        page.getByRole("button", { name: /, offline$/u }).first(),
      ).toBeVisible();
      await composer.fill("later");
      await composer.press("Enter");
      const chip = page.locator("[data-attachment-chip]");
      await expect(chip).toHaveAttribute("data-state", "failed");
      await expect(chip).toContainText("You’re offline.");
      await expect(composer).toHaveValue("later");
      await context.setOffline(false);
      expect(await uploads(page.request)).toEqual([]);
    });
  });

  test("shrinks once after a 413 with Upload-Limit", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "covered on desktop");
    await withDirectPeer(page, "shrink", async (peer, composer) => {
      await control(page.request, "limit", { bytes: "1000000" });
      await pasteImage(composer, { width: 1000, height: 1000, noise: true });
      await composer.fill("smaller");
      await composer.press("Enter");
      await approveUpload(page);
      await peer.waitForPrivmsg(
        peer.nickname,
        `smaller ${E2E_FILEHOST_ORIGIN}/`,
        "weblounge",
      );
      const [first, second] = await uploads(page.request);
      expect(first?.size).toBeGreaterThan(1_000_000);
      expect(second?.size).toBeLessThanOrEqual(1_000_000);
      expect(second?.contentType).toBe("image/jpeg");
    });
  });

  test("shows refusals on the chip and Retry sends", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "covered on desktop");
    await page.setViewportSize({ width: 1280, height: 800 });
    await withDirectPeer(page, "refused", async (peer, composer) => {
      const chip = page.locator("[data-attachment-chip]");
      await pasteImage(composer, { width: 320, height: 200 });
      await control(page.request, "next", { status: "415" });
      await composer.press("Enter");
      await approveUpload(page);
      await expect(chip).toContainText("Can’t upload this kind of image.");
      await control(page.request, "next", { status: "429" });
      await chip.getByRole("button", { name: "Retry" }).click();
      await expect(chip).toContainText("Too many uploads. Try again later.");
      await expect(chip).toHaveAttribute("data-state", "failed");
      await captureThemes(page, "desktop-error");

      await chip.getByRole("button", { name: "Retry" }).click();
      await peer.waitForPrivmsg(
        peer.nickname,
        `${E2E_FILEHOST_ORIGIN}/`,
        "weblounge",
      );
      await expect(chip).toHaveCount(0);
      expect(await uploads(page.request)).toHaveLength(3);
    });
  });

  test("notes that a network without a file host takes no uploads", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "covered on desktop");
    await rewriteIncomingText("draft/FILEHOST=", "draft/XILEHOST=");
    await withDirectPeer(page, "nohost", async (_peer, composer) => {
      const prevented = await pasteImage(composer, { width: 40, height: 40 });
      expect(prevented).toBe(false);
      await expect(
        page.getByText("This network doesn’t accept uploads."),
      ).toBeVisible();
      await expect(page.locator("[data-attachment-chip]")).toHaveCount(0);
      await composer.fill("typing on");
      await expect(
        page.getByText("This network doesn’t accept uploads."),
      ).toHaveCount(0);
    });
  });

  test("asks before sending the password to another site and remembers", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "covered on desktop");
    await page.setViewportSize({ width: 1280, height: 800 });
    await rewriteIncomingText("127.0.0.1:4175", "localhost:4175");
    await withDirectPeer(page, "foreign", async (peer, composer) => {
      await pasteImage(composer, { width: 320, height: 200 });
      await composer.fill("first");
      await composer.press("Enter");
      const dialog = page.getByRole("alertdialog", {
        name: "Allow upload to localhost:4175",
      });
      await expect(dialog).toContainText(
        "Send your password to localhost:4175?",
      );
      await expect(
        dialog.getByRole("button", { name: "Cancel" }),
      ).toBeFocused();
      expect(await uploads(page.request)).toEqual([]);
      await captureThemes(page, "desktop-approval");

      await dialog
        .getByRole("checkbox", { name: "Remember for this network" })
        .check();
      await dialog.getByRole("button", { name: "Upload" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(composer).toBeFocused();
      await peer.waitForPrivmsg(
        peer.nickname,
        `first ${E2E_FOREIGN_FILEHOST_ORIGIN}/`,
        "weblounge",
      );

      await pasteImage(composer, { width: 320, height: 200 });
      await composer.fill("second");
      await composer.press("Enter");
      await peer.waitForPrivmsg(
        peer.nickname,
        `second ${E2E_FOREIGN_FILEHOST_ORIGIN}/`,
        "weblounge",
      );
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      expect(await uploads(page.request)).toHaveLength(2);
    });
  });

  test("shows the chip inside the phone composer and sends", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "phone layout");
    await withDirectPeer(page, "phone", async (peer, composer) => {
      await composer.tap();
      await pasteImage(composer, { width: 900, height: 1200, noise: true });
      const chip = page.locator("[data-attachment-chip]");
      await expectThumbnailLoaded(chip);
      const remove = chip.getByRole("button", { name: "Remove image" });
      expect((await remove.boundingBox())?.width).toBeGreaterThanOrEqual(44);
      await composer.fill("from my phone");
      await captureThemes(page, "phone-chip");
      const key = `phone${Date.now().toString(36)}`;
      await control(page.request, "hold", { key });
      const sendStarted = await now(page);
      await page.locator("[data-composer-send]").first().tap();
      await approveUpload(page);
      await expect(chip).toHaveAttribute("data-state", "uploading");
      await captureThemes(page, "phone-uploading");
      const release = await page.request.get(
        `${E2E_FILEHOST_ORIGIN}/release/${key}`,
      );
      expect(release.ok()).toBe(true);
      await peer.waitForPrivmsg(
        peer.nickname,
        `from my phone ${E2E_FILEHOST_ORIGIN}/`,
        "weblounge",
      );
      await expect(chip).toHaveCount(0);
      await expectOnlyComposerShifts(page, sendStarted);
      await nativeFeelAudit(page);
    });
  });
});

async function withDirectPeer(
  page: Page,
  label: string,
  body: (peer: IrcClient, composer: Locator) => Promise<void>,
): Promise<void> {
  const suffix = `${label}${Date.now().toString(36)}`;
  await installNativeFeelInstrumentation(page);
  await recordShiftsOutsideComposer(page);
  await page.goto("/?irc-password=weblounge-test");
  await expect(
    page.getByRole("button", { name: /^#weblounge-test/u }).first(),
  ).toBeVisible();
  const peer = await IrcClient.connect(
    `up${suffix}`.slice(0, 16),
    "weblounge-bot",
    "weblounge-bot-test",
    `#up-${suffix}`,
  );
  try {
    await peer.privmsgConfirmed("weblounge", `uploads ${suffix}`);
    const direct = page.getByRole("button", {
      name: new RegExp(`^${peer.nickname}(?:,|$)`, "u"),
    });
    await direct.click();
    await expect(
      page.getByRole("heading", { name: peer.nickname }),
    ).toBeVisible();
    await resetNativeFeelLayoutShift(page);
    await body(peer, page.getByLabel(`Message ${peer.nickname}`));
  } finally {
    peer.close();
  }
}

/** Dispatches a synthetic clipboard paste; resolves whether the app prevented it. */
async function pasteImage(
  composer: Locator,
  image: PastedImage,
): Promise<boolean> {
  return composer.evaluate(async (field, options) => {
    const canvas = document.createElement("canvas");
    canvas.width = options.width;
    canvas.height = options.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d context");
    if (options.noise === true) {
      const pixels = context.createImageData(options.width, options.height);
      for (let index = 0; index < pixels.data.length; index += 4) {
        pixels.data[index] = Math.random() * 255;
        pixels.data[index + 1] = Math.random() * 255;
        pixels.data[index + 2] = Math.random() * 255;
        pixels.data[index + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
    } else {
      const gradient = context.createLinearGradient(0, 0, options.width, 0);
      gradient.addColorStop(0, "rgb(120, 180, 160)");
      gradient.addColorStop(1, "rgb(230, 190, 120)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, options.width, options.height);
    }
    const type = options.type ?? "image/png";
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value === null ? reject(new Error("toBlob")) : resolve(value),
        type,
      ),
    );
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (options.withGpsExif === true) {
      const exif = [..."Exif\0\0II"].map((character) =>
        character.charCodeAt(0),
      );
      const ifd = [
        0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x02, 0x00, 0x12, 0x01, 0x03, 0x00,
        0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x25, 0x88, 0x04, 0x00,
        0x01, 0x00, 0x00, 0x00, 0x26, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ];
      const gps = [..."GPS-37.7749N"].map((character) =>
        character.charCodeAt(0),
      );
      const payload = [...exif, ...ifd, ...gps];
      const length = payload.length + 2;
      const segment = [0xff, 0xe1, length >> 8, length & 0xff, ...payload];
      bytes = new Uint8Array([
        ...bytes.subarray(0, 2),
        ...segment,
        ...bytes.subarray(2),
      ]);
    }
    const name = type === "image/jpeg" ? "IMG_2041.jpg" : "image.png";
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, { type }));
    if (options.text !== undefined)
      transfer.setData("text/plain", options.text);
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    field.dispatchEvent(event);
    return event.defaultPrevented;
  }, image);
}

async function expectThumbnailLoaded(chip: Locator): Promise<void> {
  await expect
    .poll(() =>
      chip
        .locator("[data-attachment-thumbnail]")
        .evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth,
        ),
    )
    .toBeGreaterThan(0);
}

async function progressOf(chip: Locator): Promise<number> {
  const value = await chip
    .locator("[data-upload-progress]")
    .getAttribute("data-upload-progress");
  return value === null ? 0 : Number(value);
}

async function control(
  request: APIRequestContext,
  action: "reset" | "hold" | "limit" | "next",
  parameters: Record<string, string> = {},
): Promise<void> {
  const url = new URL(`/control/${action}`, E2E_FILEHOST_ORIGIN);
  for (const [name, value] of Object.entries(parameters))
    url.searchParams.set(name, value);
  const response = await request.post(url.href);
  expect(response.ok()).toBe(true);
}

async function uploads(
  request: APIRequestContext,
): Promise<readonly RecordedUpload[]> {
  const response = await request.get(`${E2E_FILEHOST_ORIGIN}/control/uploads`);
  return (await response.json()) as RecordedUpload[];
}

async function rewriteIncomingText(from: string, to: string): Promise<void> {
  const url = new URL("/rewrite-text", forwarder);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  const response = await fetch(url, { method: "POST" });
  if (!response.ok)
    throw new Error(`could not arm rewrite: ${response.status}`);
}

async function clearTextRewrites(): Promise<void> {
  const response = await fetch(new URL("/clear-text-rewrites", forwarder), {
    method: "POST",
  });
  if (!response.ok) throw new Error("could not clear rewrites");
}

async function captureThemes(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme === "light" ? "lounge" : "lounge-night",
    );
    await mkdir(screenshots, { recursive: true });
    await screenshotWithInter(page.locator("[data-app-root]"), {
      path: path.join(screenshots, `${name}-${theme}.png`),
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

// Records which elements outside the composer moved. Only Chromium reports layout shifts, so
// the chromium and android projects carry this check and WebKit runs it vacuously.
async function recordShiftsOutsideComposer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const shifts: { at: number; nodes: string[] }[] = [];
    Reflect.set(window, "__uploadShifts", shifts);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const sources = (entry as unknown as { sources: { node?: Node }[] })
            .sources;
          shifts.push({
            at: entry.startTime,
            nodes: sources
              .map((source) => source.node)
              .filter(
                (node): node is Element =>
                  node instanceof Element &&
                  node.closest("[data-composer]") === null,
              )
              .map((node) => node.outerHTML.slice(0, 120)),
          });
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      // WebKit reports no layout shifts; the native-feel audit covers what it can.
    }
  });
}

/**
 * The composer grows and shrinks with its chip, like a new line of text; nothing else may move.
 * Then resets the native-feel layout-shift total so the audit checks everything else.
 */
async function expectOnlyComposerShifts(
  page: Page,
  since: number,
): Promise<void> {
  const outside = await page.evaluate((start) => {
    const shifts = Reflect.get(window, "__uploadShifts") as {
      at: number;
      nodes: string[];
    }[];
    return shifts
      .filter((shift) => shift.at >= start)
      .flatMap((shift) => shift.nodes);
  }, since);
  expect(outside).toEqual([]);
  await resetNativeFeelLayoutShift(page);
}

function now(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

// The fake file host is on the IRC endpoint's host but another port, so the password asks first.
async function approveUpload(page: Page): Promise<void> {
  const dialog = page.getByRole("alertdialog", {
    name: "Allow upload to 127.0.0.1:4175",
  });
  await dialog
    .getByRole("checkbox", { name: "Remember for this network" })
    .check();
  await dialog.getByRole("button", { name: "Upload" }).click();
  await expect(dialog).toHaveCount(0);
}
