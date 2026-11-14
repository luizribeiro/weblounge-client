import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { claimNickname } from "./irc-nick-claim";

const host = process.env.WEBLOUNGE_E2E_IRC_HOST ?? "127.0.0.1";
const port = Number(process.env.WEBLOUNGE_E2E_IRC_PORT ?? 6667);
const ircTimeoutMilliseconds = 5_000;

export class IrcClient {
  readonly #socket: Socket;
  readonly #lines: string[] = [];
  #buffer = "";
  #nickname: string;

  private constructor(socket: Socket, nickname: string) {
    this.#socket = socket;
    this.#nickname = nickname;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      const lines = this.#buffer.split("\r\n");
      this.#buffer = lines.pop() ?? "";
      this.#lines.push(...lines);
    });
  }

  static async connect(
    nickname: string,
    account: string,
    password: string,
    channel: string,
  ): Promise<IrcClient> {
    const client = await IrcClient.connectWithoutJoin(
      nickname,
      account,
      password,
    );
    client.send(`JOIN ${channel}`);
    await client.waitFor(
      `JOIN confirmation for ${channel}`,
      (line) => line.includes(`!`) && line.includes(` JOIN ${channel}`),
    );
    return client;
  }

  static async connectWithoutJoin(
    nickname: string,
    account: string,
    password: string,
  ): Promise<IrcClient> {
    const socket = await connectedSocket();
    const client = new IrcClient(socket, nickname);
    try {
      await client.#registerWithPassword(account, password);
    } catch (error) {
      socket.destroy();
      throw error;
    }
    return client;
  }

  async #registerWithPassword(account: string, password: string) {
    this.send("CAP LS 302");
    this.send(`NICK ${this.#nickname}`);
    this.send(`USER ${this.#nickname} 0 * :${this.#nickname}`);
    await this.waitFor("capability list", (line) =>
      line.includes(" CAP * LS "),
    );
    this.send(
      "CAP REQ :account-tag batch draft/multiline draft/read-marker echo-message message-tags sasl server-time",
    );
    await this.waitFor(
      "requested capability acknowledgement",
      (line) =>
        line.includes(" CAP * ACK ") &&
        line.includes("account-tag") &&
        line.includes("batch") &&
        line.includes("draft/multiline") &&
        line.includes("draft/read-marker") &&
        line.includes("message-tags") &&
        line.includes("sasl") &&
        line.includes("echo-message") &&
        line.includes("server-time"),
    );
    this.send("AUTHENTICATE PLAIN");
    await this.waitFor("SASL PLAIN authentication prompt", (line) =>
      line.endsWith("AUTHENTICATE +"),
    );
    const credentials = Buffer.from(`\0${account}\0${password}`).toString(
      "base64",
    );
    this.send(`AUTHENTICATE ${credentials}`);
    await this.waitFor("SASL success numeric", (line) =>
      line.includes(" 903 "),
    );
    this.send("CAP END");
    const welcome = await this.waitFor("welcome numeric", (line) =>
      line.includes(" 001 "),
    );
    this.#nickname = welcome.match(/ 001 (\S+) /u)?.[1] ?? this.#nickname;
  }

  static async connectOAuth(
    nickname: string,
    token: string,
  ): Promise<IrcClient> {
    const socket = await connectedSocket();
    const client = new IrcClient(socket, nickname);
    client.send("CAP LS 302");
    client.send(`NICK ${nickname}`);
    client.send(`USER ${nickname} 0 * :${nickname}`);
    await client.waitFor("capability list", (line) =>
      line.includes(" CAP * LS "),
    );
    client.send("CAP REQ :draft/read-marker message-tags sasl server-time");
    await client.waitFor(
      "OAuth client capability acknowledgement",
      (line) =>
        line.includes(" CAP * ACK ") &&
        line.includes("draft/read-marker") &&
        line.includes("message-tags") &&
        line.includes("sasl") &&
        line.includes("server-time"),
    );
    client.send("AUTHENTICATE OAUTHBEARER");
    await client.waitFor("SASL OAUTHBEARER authentication prompt", (line) =>
      line.endsWith("AUTHENTICATE +"),
    );
    const credentials = Buffer.from(
      `n,,\u0001auth=Bearer ${token}\u0001\u0001`,
    ).toString("base64");
    client.send(`AUTHENTICATE ${credentials}`);
    await client.waitFor("SASL success numeric", (line) =>
      line.includes(" 903 "),
    );
    client.send("CAP END");
    const welcome = await client.waitFor("welcome numeric", (line) =>
      line.includes(" 001 "),
    );
    client.#nickname = welcome.match(/ 001 (\S+) /u)?.[1] ?? nickname;
    return client;
  }

  static async connectIsolated(
    nickname: string,
    channel: string,
  ): Promise<IrcClient> {
    const password = isolatedPassword(nickname);
    await registerAccount(nickname, password);
    return IrcClient.connect(nickname, nickname, password, channel);
  }

  get nickname(): string {
    return this.#nickname;
  }

  async join(channel: string): Promise<void> {
    this.send(`JOIN ${channel}`);
    await this.waitFor(
      `JOIN confirmation for ${channel}`,
      (line) => line.includes(`!`) && line.includes(` JOIN ${channel}`),
    );
  }

  async joinAll(channels: readonly string[]): Promise<void> {
    if (channels.length === 0) return;
    this.send(`JOIN ${channels.join(",")}`);
    for (const channel of channels)
      await this.waitFor(
        `JOIN confirmation for ${channel}`,
        (line) => line.includes("!") && line.includes(` JOIN ${channel}`),
      );
  }

  privmsg(channel: string, text: string): void {
    this.send(`PRIVMSG ${channel} :${text}`);
  }

  async privmsgConfirmed(channel: string, text: string): Promise<string> {
    this.privmsg(channel, text);
    return this.waitFor(
      `echoed PRIVMSG to ${channel}`,
      (line) =>
        lineTargets(line, "PRIVMSG", channel) && line.endsWith(` :${text}`),
    );
  }

  async privmsgReplyConfirmed(
    target: string,
    text: string,
    replyTo: string,
  ): Promise<string> {
    this.send(`@+draft/reply=${replyTo} PRIVMSG ${target} :${text}`);
    return this.waitFor(
      `echoed reply PRIVMSG to ${target}`,
      (line) =>
        line.includes(`+draft/reply=${replyTo}`) &&
        lineTargets(line, "PRIVMSG", target) &&
        line.endsWith(` :${text}`),
    );
  }

  async noticeConfirmed(channel: string, text: string): Promise<string> {
    this.send(`NOTICE ${channel} :${text}`);
    return this.waitFor(`echoed NOTICE to ${channel}`, (line) =>
      line.includes(` NOTICE ${channel} :${text}`),
    );
  }

  async waitForPrivmsg(
    target: string,
    text: string,
    nickname: string,
  ): Promise<string> {
    return this.waitFor(
      `PRIVMSG from ${nickname} to ${target}`,
      (line) =>
        line.includes(`:${nickname}!`) &&
        line.includes(` PRIVMSG ${target} :${text}`),
    );
  }

  async waitForNextJoin(target: string, nickname: string): Promise<void> {
    const matches = (line: string) =>
      line.includes(`:${nickname}!`) && line.includes(` JOIN ${target}`);
    this.#discardLines(matches);
    await this.waitFor(`${nickname} to rejoin ${target}`, matches);
  }

  async waitForNextPart(target: string, nickname: string): Promise<void> {
    const matches = (line: string) =>
      line.includes(`:${nickname}!`) && line.includes(` PART ${target}`);
    this.#discardLines(matches);
    await this.waitFor(`${nickname} to leave ${target}`, matches);
  }

  async waitForNextQuit(nickname: string): Promise<void> {
    const matches = (line: string) =>
      line.includes(`:${nickname}!`) && line.includes(" QUIT ");
    this.#discardLines(matches);
    await this.waitFor(`${nickname} to disconnect`, matches);
  }

  async markRead(target: string, timestamp: string): Promise<void> {
    this.send(`MARKREAD ${target} timestamp=${timestamp}`);
    await this.waitFor(`MARKREAD confirmation for ${target}`, (line) =>
      line.includes(` MARKREAD ${target} timestamp=${timestamp}`),
    );
  }

  async enablePersistence(): Promise<void> {
    this.send("CAP REQ :draft/persistence");
    await this.waitFor("persistence capability acknowledgement", (line) =>
      line.includes(" ACK draft/persistence"),
    );
    this.send("PERSISTENCE SET ON");
    await this.waitFor(
      "enabled persistence status",
      (line) => line.includes(" PERSISTENCE STATUS ") && line.endsWith(" ON"),
    );
  }

  async readMarker(target: string): Promise<string | undefined> {
    this.send(`MARKREAD ${target}`);
    const response = await this.waitFor(`read marker for ${target}`, (line) =>
      line.includes(` MARKREAD ${target} `),
    );
    return / timestamp=([^ ]+)/u.exec(response)?.[1];
  }

  async privmsgSplitConfirmed(
    channel: string,
    text: string,
    maxBytes = 320,
  ): Promise<string[]> {
    const parts: string[] = [];
    let part = "";
    for (const character of text) {
      if (Buffer.byteLength(part + character) > maxBytes && part !== "") {
        parts.push(part);
        part = character;
      } else {
        part += character;
      }
    }
    if (part !== "") parts.push(part);
    for (const item of parts) await this.privmsgConfirmed(channel, item);
    return parts;
  }

  async multilineConfirmed(channel: string, text: string): Promise<void> {
    const reference = `playwright-${Date.now().toString(36)}`;
    this.send(`BATCH +${reference} draft/multiline ${channel}`);
    for (const segment of text.split("\n"))
      this.send(`@batch=${reference} PRIVMSG ${channel} :${segment}`);
    this.send(`BATCH -${reference}`);
    const finalText = text.split("\n").findLast((segment) => segment !== "");
    if (finalText !== undefined)
      await this.waitFor(`final multiline echo to ${channel}`, (line) =>
        line.includes(` PRIVMSG ${channel} :${finalText}`),
      );
  }

  async actionConfirmed(channel: string, text: string): Promise<void> {
    await this.privmsgConfirmed(channel, `\u0001ACTION ${text}\u0001`);
  }

  async reactionConfirmed(
    target: string,
    messageId: string,
    reaction: string,
  ): Promise<void> {
    this.send(
      `@+draft/react=${reaction};+draft/reply=${messageId} TAGMSG ${target}`,
    );
    await this.waitFor(
      `echoed reaction to ${target}`,
      (line) =>
        line.includes(`+draft/react=${reaction}`) &&
        line.includes(`+draft/reply=${messageId}`) &&
        line.includes(` TAGMSG ${target}`),
    );
  }

  async unreactionConfirmed(
    target: string,
    messageId: string,
    reaction: string,
  ): Promise<void> {
    this.send(
      `@+draft/unreact=${reaction};+draft/reply=${messageId} TAGMSG ${target}`,
    );
    await this.waitFor(
      `echoed removed reaction to ${target}`,
      (line) =>
        line.includes(`+draft/unreact=${reaction}`) &&
        line.includes(`+draft/reply=${messageId}`) &&
        line.includes(` TAGMSG ${target}`),
    );
  }

  async typingConfirmed(
    target: string,
    state: "active" | "paused" | "done",
  ): Promise<string> {
    this.send(`@+typing=${state} TAGMSG ${target}`);
    return this.waitFor(`echoed ${state} typing state to ${target}`, (line) =>
      isTypingLine(line, target, state, this.#nickname),
    );
  }

  async waitForNextTyping(
    target: string,
    nickname: string,
  ): Promise<"active" | "paused" | "done"> {
    const line = await this.waitFor(`typing state from ${nickname}`, (entry) =>
      isTypingLine(entry, target, undefined, nickname),
    );
    const state = /(?:^|;|@)\+typing=(active|paused|done)(?:;| )/u.exec(
      line,
    )?.[1];
    if (state !== "active" && state !== "paused" && state !== "done") {
      throw new Error(`Could not parse typing state: ${line}`);
    }
    return state;
  }

  async mode(
    target: string,
    change: string,
    ...parameters: string[]
  ): Promise<void> {
    const arguments_ =
      parameters.length === 0 ? "" : ` ${parameters.join(" ")}`;
    this.send(`MODE ${target} ${change}${arguments_}`);
    await this.waitFor(`MODE confirmation for ${target}`, (line) =>
      line.includes(` MODE ${target} ${change}${arguments_}`),
    );
  }

  async kick(channel: string, nick: string, reason: string): Promise<void> {
    this.send(`KICK ${channel} ${nick} :${reason}`);
    await this.waitFor(`KICK confirmation for ${nick}`, (line) =>
      line.includes(` KICK ${channel} ${nick} :${reason}`),
    );
  }

  async nick(nickname: string): Promise<void> {
    const previous = this.#nickname;
    await claimNickname(
      previous,
      nickname,
      (line) => this.send(line),
      (description, predicate) => this.waitFor(description, predicate),
    );
    this.#nickname = nickname;
  }

  async waitForNickDeparture(nickname: string): Promise<void> {
    const isStatus = (line: string, numeric: "730" | "731") =>
      line.includes(` ${numeric} `) &&
      line
        .split(/[ ,]/u)
        .some((entry) => entry.replace(/^:/u, "").split("!")[0] === nickname);
    const isOnline = (line: string) => isStatus(line, "730");
    const isOffline = (line: string) => isStatus(line, "731");
    this.#discardLines((line) => isOnline(line) || isOffline(line));
    this.send(`MONITOR + ${nickname}`);
    const status = await this.waitFor(
      `MONITOR status for ${nickname}`,
      (line) => isOnline(line) || isOffline(line),
    );
    if (isOnline(status)) {
      await this.waitFor(`MONITOR offline status for ${nickname}`, isOffline);
    }
  }

  async setAway(message: string | undefined): Promise<void> {
    const [command, numeric] =
      message === undefined ? ["AWAY", " 305 "] : [`AWAY :${message}`, " 306 "];
    this.send(command);
    await this.waitFor(`AWAY confirmation${numeric}`, (line) =>
      line.includes(numeric),
    );
  }

  async part(channel: string): Promise<void> {
    this.send(`PART ${channel} :screenshot seed complete`);
    await this.waitFor(`PART confirmation for ${channel}`, (line) =>
      line.includes(` PART ${channel} `),
    );
  }

  async setAlwaysOn(enabled: boolean): Promise<void> {
    this.privmsg("NickServ", `SET ALWAYS-ON ${enabled ? "true" : "false"}`);
    await this.waitFor("always-on setting confirmation", (line) =>
      line.includes("Successfully changed your account settings"),
    );
  }

  async pushSubscriptionEndpoints(): Promise<readonly string[]> {
    const count = await this.#nickServCount(
      "PUSH LIST",
      /(?:push subscription\(s\)|Subscription [0-9]+:|Endpoint:|Last renewal:|Last push:)/u,
      / has ([0-9]+) push subscription\(s\)/u,
    );
    const endpoints: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const endpoint = await this.waitFor(
        "push subscription endpoint",
        (line) => line.includes("Endpoint:"),
      );
      const value = /Endpoint:\s+(\S+)/u.exec(endpoint)?.[1];
      if (value === undefined) {
        throw new Error(
          `Could not parse push subscription endpoint: ${endpoint}`,
        );
      }
      endpoints.push(value);
    }
    return endpoints;
  }

  async attachedClientCount(): Promise<number> {
    // Ergo's SESSIONS reply really spells it "clients(s)".
    return this.#nickServCount(
      "SESSIONS",
      /(?:attached clients\(s\)|Client [0-9]+|IP address:|Hostname:|Created at:|Last active:|IRCv3 CAPs:)/u,
      / has ([0-9]+) attached clients\(s\)/u,
    );
  }

  async #nickServCount(
    command: string,
    staleReply: RegExp,
    countReply: RegExp,
  ): Promise<number> {
    this.#discardLines((line) => staleReply.test(line));
    this.privmsg("NickServ", command);
    const response = await this.waitFor(`NickServ ${command} count`, (line) =>
      countReply.test(line),
    );
    const count = countReply.exec(response)?.[1];
    if (count === undefined) {
      throw new Error(`Could not parse NickServ ${command} count: ${response}`);
    }
    return Number.parseInt(count, 10);
  }

  close(): void {
    if (this.#socket.writableEnded) return;
    this.#socket.end("QUIT :test complete\r\n");
  }

  async waitForDisconnect(): Promise<void> {
    if (this.#socket.destroyed) return;
    await once(this.#socket, "close");
  }

  private send(line: string): void {
    this.#socket.write(`${line}\r\n`);
  }

  #discardLines(predicate: (line: string) => boolean): void {
    for (let index = this.#lines.length - 1; index >= 0; index -= 1) {
      if (predicate(this.#lines[index] ?? "")) this.#lines.splice(index, 1);
    }
  }

  private async waitFor(
    description: string,
    predicate: (line: string) => boolean,
  ): Promise<string> {
    const signal = AbortSignal.timeout(ircTimeoutMilliseconds);
    try {
      for (;;) {
        const index = this.#lines.findIndex(predicate);
        if (index !== -1) return this.#lines.splice(index, 1)[0] ?? "";
        await once(this.#socket, "data", { signal });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      throw new Error(
        `IRC response timed out waiting for ${description} as ${this.#nickname}; received ${this.#lines.join(" | ")}`,
        { cause: error },
      );
    }
  }
}

export function messageTag(line: string, name: string): string {
  const value = new RegExp(`(?:^@|;)${name}=([^; ]+)`, "u").exec(line)?.[1];
  if (value === undefined) throw new Error(`IRC line has no ${name}: ${line}`);
  return value;
}

export function messageId(line: string): string {
  return messageTag(line, "msgid");
}

export function serverTime(line: string): string {
  return messageTag(line, "time");
}

export function isolatedPassword(account: string): string {
  return `test-${account}`;
}

export async function registerAccount(
  account: string,
  password: string,
): Promise<void> {
  const response = await fetch(
    process.env.WEBLOUNGE_E2E_IRC_API ?? "http://127.0.0.1:8089/v1/saregister",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WEBLOUNGE_E2E_IRC_API_TOKEN ?? "weblounge-local-api-token"}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountName: account, passphrase: password }),
    },
  );
  const result: unknown = await response.json();
  if (
    !response.ok ||
    typeof result !== "object" ||
    result === null ||
    !("success" in result) ||
    result.success !== true
  ) {
    throw new Error(`Could not create isolated IRC account ${account}`);
  }
}

function isTypingLine(
  line: string,
  target: string,
  state: "active" | "paused" | "done" | undefined,
  nickname: string,
): boolean {
  return (
    (state === undefined
      ? /(?:^|;|@)\+typing=(?:active|paused|done)(?:;| )/u.test(line)
      : line.includes(`+typing=${state}`)) &&
    line.includes(`:${nickname}!`) &&
    lineTargets(line, "TAGMSG", target)
  );
}

function lineTargets(line: string, command: string, target: string): boolean {
  const actual = new RegExp(` ${command} (\\S+)`, "u").exec(line)?.[1];
  return actual?.toLowerCase() === target.toLowerCase();
}

async function connectedSocket(): Promise<Socket> {
  const socket = createConnection({ host, port });
  const signal = AbortSignal.timeout(ircTimeoutMilliseconds);
  try {
    await once(socket, "connect", { signal });
    return socket;
  } catch (error) {
    socket.destroy();
    if (!signal.aborted) throw error;
    throw new Error(`IRC connection to ${host}:${port} timed out`, {
      cause: error,
    });
  }
}
