import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  Browser,
  BrowserContextOptions,
  Locator,
  Page,
} from "@playwright/test";
import type { IrcClient } from "./irc-client";
import { expect, type IrcTestAccount, test } from "./irc-fixture";
import { choose, choosePhoneAppearance } from "./settings-fixture";
import { backToChatList, expectSettled } from "./settled";
import { escapeRegex } from "./sidebar-rows";

/** Review captures of every presence state; CI skips them, a review run sets the variable. */
test.skip(
  process.env.WEBLOUNGE_E2E_ERGO !== "1" ||
    process.env.WEBLOUNGE_PRESENCE_SCREENSHOTS !== "1",
  "captures presence screenshots for review only",
);

const directory = path.join(process.cwd(), "e2e", "screenshots", "f53");

interface Layout {
  readonly name: "desktop" | "phone";
  readonly context: BrowserContextOptions;
}

const layouts: readonly Layout[] = [
  { name: "desktop", context: { viewport: { width: 1_280, height: 800 } } },
  {
    name: "phone",
    context: {
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    },
  },
];

const themes = ["light", "dark", "ne"] as const;

for (const layout of layouts) {
  for (const theme of themes) {
    const setting = { layout, theme };

    test(`${layout.name} ${theme}: online at launch, a person and a bot`, async ({
      browser,
      baseURL,
      irc,
    }) => {
      await session({ ...setting, browser, baseURL, irc }, async (screens) => {
        const [ana, iris] = await screens.peers("ana", "iris");
        await screens.relaunch();
        await screens.capture("list");
        await screens.open(ana.nickname, /^Online$/u, "online");
        await screens.open(iris.nickname, /^Online$/u, "bot-online");
      });
    });

    test(`${layout.name} ${theme}: away and offline at launch, with no time`, async ({
      browser,
      baseURL,
      irc,
    }) => {
      await session({ ...setting, browser, baseURL, irc }, async (screens) => {
        const [bruno, kit] = await screens.peers("bruno", "kit");
        await bruno.setAway("lunch");
        kit.close();
        await kit.waitForDisconnect();
        await screens.relaunch();
        await screens.open(bruno.nickname, /^Away$/u, "away");
        await screens.open(kit.nickname, /^Offline$/u, "offline");
      });
    });

    test(`${layout.name} ${theme}: changes seen this session, with times`, async ({
      browser,
      baseURL,
      irc,
    }) => {
      await session({ ...setting, browser, baseURL, irc }, async (screens) => {
        const [ana, iris] = await screens.peers("ana", "iris");
        await screens.expectOnline(ana.nickname);
        await screens.expectOnline(iris.nickname);
        await ana.setAway("lunch");
        await screens.open(ana.nickname, /^Away since \S/u, "away-since");
        await iris.setAway("recharging");
        await screens.open(iris.nickname, /^Away since \S/u, "bot-away");
        ana.close();
        await ana.waitForDisconnect();
        await screens.open(
          ana.nickname,
          /^Offline, last seen \S/u,
          "offline-last-seen",
        );
        iris.close();
        await iris.waitForDisconnect();
        await screens.open(
          iris.nickname,
          /^Offline, last seen \S/u,
          "bot-offline",
        );
      });
    });
  }
}

interface SessionOptions {
  readonly browser: Browser;
  readonly baseURL: string | undefined;
  readonly irc: IrcTestAccount;
  readonly layout: Layout;
  readonly theme: (typeof themes)[number];
}

/** The app open in the chosen layout and theme; peers come from `Screens.peers`. */
async function session(
  options: SessionOptions,
  body: (screens: Screens) => Promise<void>,
): Promise<void> {
  const { irc, layout, theme } = options;
  const context = await options.browser.newContext({
    baseURL: options.baseURL,
    ...layout.context,
  });
  await irc.scope(context);
  const page = await context.newPage();
  const screens = new Screens(page, layout, theme, irc);
  try {
    await page.emulateMedia({
      colorScheme: theme === "dark" ? "dark" : "light",
    });
    await page.goto(irc.url());
    await screens.joined();
    if (theme === "ne") await screens.chooseNe();
    await body(screens);
  } finally {
    screens.closePeers();
    await context.close();
  }
}

class Screens {
  #inConversation: string | undefined;
  readonly #peers: IrcClient[] = [];

  constructor(
    private readonly page: Page,
    private readonly layout: Layout,
    private readonly theme: (typeof themes)[number],
    private readonly irc: IrcTestAccount,
  ) {}

  /** Peers sharing no channel who have each sent us a DM; one named iris is a bot. */
  async peers(...labels: readonly string[]): Promise<IrcClient[]> {
    const peers = await Promise.all(
      labels.map((label) => this.irc.peer(label, [])),
    );
    this.#peers.push(...peers);
    for (const [index, peer] of peers.entries()) {
      if (labels[index] === "iris") await peer.mode(peer.nickname, "+B");
      await peer.privmsgConfirmed(this.irc.account, `hello ${this.irc.id}`);
    }
    return peers;
  }

  closePeers(): void {
    for (const peer of this.#peers) peer.close();
  }

  /** A change is only dated once MONITOR has reported the peer online. */
  async expectOnline(nick: string): Promise<void> {
    await expect(
      row(this.page, nick).locator('[data-presence="online"]'),
    ).toBeVisible();
  }

  async relaunch(): Promise<void> {
    await this.page.goto(this.irc.url());
    await this.joined();
  }

  /** A shown channel proves registration, so peers' lines reach us after it. */
  async joined(): Promise<void> {
    const channel = this.irc.channel;
    if (this.layout.name === "phone") {
      await this.page
        .getByRole("button", { exact: true, name: channel })
        .click();
      await expectSettled(this.page, { conversation: channel });
      await backToChatList(this.page, channel);
      this.#inConversation = undefined;
    } else {
      await expectSettled(this.page, { conversation: channel });
    }
  }

  async chooseNe(): Promise<void> {
    if (this.layout.name === "phone") {
      await choosePhoneAppearance(this.page, ["n.e."]);
    } else {
      await this.page
        .getByRole("complementary", { name: "Channel list" })
        .getByRole("button", { name: "Settings" })
        .click();
      await choose(this.page, "n.e.");
      await this.page.keyboard.press("Escape");
      await expect(
        this.page.getByRole("dialog", { name: "Settings" }),
      ).toBeHidden();
    }
    await expect(this.page.locator("html")).toHaveAttribute("data-theme", "ne");
  }

  async open(nick: string, status: RegExp, name: string): Promise<void> {
    if (this.layout.name === "phone" && this.#inConversation !== undefined)
      await backToChatList(this.page, this.#inConversation);
    await row(this.page, nick).click();
    await expectSettled(this.page, { conversation: nick });
    this.#inConversation = nick;
    await expect(this.page.locator("[data-direct-presence]")).toHaveText(
      status,
    );
    await this.capture(name);
  }

  async capture(name: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    await this.page.screenshot({
      path: path.join(
        directory,
        `${this.layout.name}-${this.theme}-${name}.png`,
      ),
    });
  }
}

function row(page: Page, nick: string): Locator {
  return page.getByRole("button", {
    name: new RegExp(`^${escapeRegex(nick)}(?:,|$)`, "u"),
  });
}
