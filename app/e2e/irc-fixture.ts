import { randomBytes } from "node:crypto";
import { type BrowserContext, test as base } from "@playwright/test";
import { Forwarder } from "./forwarder";
import { IrcClient, isolatedPassword, registerAccount } from "./irc-client";
import { scopeCookieName } from "./socket-forwarder-scope.mjs";

const maximumNickLength = 32;

export interface StartUrlOptions {
  readonly autojoin?: readonly string[];
  readonly path?: string;
}

export interface IrcTestAccount {
  readonly id: string;
  readonly account: string;
  readonly password: string;
  readonly channel: string;
  readonly forwarder: Forwarder;
  channelNamed(label: string): string;
  nickNamed(label: string): string;
  url(options?: StartUrlOptions): string;
  peer(label: string, channels?: readonly string[]): Promise<IrcClient>;
  self(channels?: readonly string[]): Promise<IrcClient>;
  scope(context: BrowserContext): Promise<void>;
}

export const test = base.extend<{ irc: IrcTestAccount }>({
  irc: async ({ baseURL, context }, use, testInfo) => {
    testInfo.skip(
      process.env.WEBLOUNGE_E2E_ERGO !== "1",
      "requires the flake's local Ergo fixture",
    );
    if (baseURL === undefined)
      throw new Error("Playwright base URL is missing");
    const clients: IrcClient[] = [];
    const environment = await createIrcTestAccount(baseURL, clients);
    await environment.scope(context);
    try {
      await use(environment);
    } finally {
      for (const client of clients) client.close();
      await Promise.all(clients.map((client) => client.waitForDisconnect()));
    }
  },
});

export { expect } from "@playwright/test";

async function createIrcTestAccount(
  baseURL: string,
  clients: IrcClient[],
): Promise<IrcTestAccount> {
  const id = randomBytes(4).toString("hex");
  const nickNamed = (label: string) => {
    const nick = `${label}-${id}`;
    if (nick.length > maximumNickLength)
      throw new Error(`test nick ${nick} exceeds ${maximumNickLength} bytes`);
    return nick;
  };
  const account = `me${id}`;
  const password = isolatedPassword(account);
  const channel = `#${nickNamed("room")}`;
  await registerAccount(account, password);
  const connect = async (login: string, channels: readonly string[]) => {
    const client = await IrcClient.connectWithoutJoin(
      login,
      login,
      isolatedPassword(login),
    );
    clients.push(client);
    await client.joinAll(channels);
    return client;
  };
  return {
    id,
    account,
    password,
    channel,
    forwarder: new Forwarder(account),
    channelNamed: (label) => `#${nickNamed(label)}`,
    nickNamed,
    url: ({ autojoin = [], path = "/" } = {}) => {
      const url = new URL(path, baseURL);
      url.searchParams.set("irc-account", account);
      url.searchParams.set("irc-nickname", account);
      url.searchParams.set("irc-password", password);
      url.searchParams.set("irc-channel", channel);
      for (const joined of autojoin)
        url.searchParams.append("irc-autojoin", joined);
      return `${url.pathname}${url.search}${url.hash}`;
    },
    peer: async (label, channels = [channel]) => {
      const nick = nickNamed(label);
      await registerAccount(nick, isolatedPassword(nick));
      return connect(nick, channels);
    },
    self: (channels = []) => connect(account, channels),
    scope: (context) =>
      context.addCookies([
        { name: scopeCookieName, value: account, url: baseURL },
      ]),
  };
}
