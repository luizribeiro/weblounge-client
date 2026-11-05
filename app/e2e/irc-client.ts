import { once } from "node:events";
import { createConnection, type Socket } from "node:net";

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
    const socket = await connectedSocket();
    const client = new IrcClient(socket, nickname);
    client.send("CAP LS 302");
    client.send(`NICK ${nickname}`);
    client.send(`USER ${nickname} 0 * :${nickname}`);
    await client.waitFor("capability list", (line) =>
      line.includes(" CAP * LS "),
    );
    client.send(
      "CAP REQ :batch draft/multiline echo-message message-tags sasl server-time",
    );
    await client.waitFor(
      "requested capability acknowledgement",
      (line) =>
        line.includes(" CAP * ACK ") &&
        line.includes("batch") &&
        line.includes("draft/multiline") &&
        line.includes("message-tags") &&
        line.includes("sasl") &&
        line.includes("echo-message") &&
        line.includes("server-time"),
    );
    client.send("AUTHENTICATE PLAIN");
    await client.waitFor("SASL PLAIN authentication prompt", (line) =>
      line.endsWith("AUTHENTICATE +"),
    );
    const credentials = Buffer.from(`\0${account}\0${password}`).toString(
      "base64",
    );
    client.send(`AUTHENTICATE ${credentials}`);
    await client.waitFor("SASL success numeric", (line) =>
      line.includes(" 903 "),
    );
    client.send("CAP END");
    const welcome = await client.waitFor("welcome numeric", (line) =>
      line.includes(" 001 "),
    );
    client.#nickname = welcome.match(/ 001 (\S+) /u)?.[1] ?? nickname;
    client.send(`JOIN ${channel}`);
    await client.waitFor(
      `JOIN confirmation for ${channel}`,
      (line) => line.includes(`!`) && line.includes(` JOIN ${channel}`),
    );
    return client;
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
    const password = `test-${nickname}`;
    const response = await fetch(
      process.env.WEBLOUNGE_E2E_IRC_API ??
        "http://127.0.0.1:8089/v1/saregister",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WEBLOUNGE_E2E_IRC_API_TOKEN ?? "weblounge-local-api-token"}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ accountName: nickname, passphrase: password }),
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
      throw new Error(`Could not create isolated IRC account ${nickname}`);
    }
    return IrcClient.connect(nickname, nickname, password, channel);
  }

  get nickname(): string {
    return this.#nickname;
  }

  privmsg(channel: string, text: string): void {
    this.send(`PRIVMSG ${channel} :${text}`);
  }

  async privmsgConfirmed(channel: string, text: string): Promise<string> {
    this.privmsg(channel, text);
    return this.waitFor(`echoed PRIVMSG to ${channel}`, (line) =>
      line.includes(` PRIVMSG ${channel} :${text}`),
    );
  }

  async markRead(target: string, timestamp: string): Promise<void> {
    this.send(`MARKREAD ${target} timestamp=${timestamp}`);
    await this.waitFor(`MARKREAD confirmation for ${target}`, (line) =>
      line.includes(` MARKREAD ${target} timestamp=${timestamp}`),
    );
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
        line.includes(`+draft/react=${reaction};+draft/reply=${messageId}`) &&
        line.includes(` TAGMSG ${target}`),
    );
  }

  async mode(target: string, change: string, nick?: string): Promise<void> {
    const argument = nick === undefined ? "" : ` ${nick}`;
    this.send(`MODE ${target} ${change}${argument}`);
    await this.waitFor(`MODE confirmation for ${target}`, (line) =>
      line.includes(` MODE ${target} ${change}${argument}`),
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
    this.send(`NICK ${nickname}`);
    await this.waitFor(
      `NICK confirmation for ${nickname}`,
      (line) =>
        line.includes(`:${previous}!`) &&
        (line.includes(` NICK :${nickname}`) ||
          line.includes(` NICK ${nickname}`)),
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
    this.#discardLines((line) =>
      /(?:push subscription\(s\)|Subscription [0-9]+:|Endpoint:|Last renewal:|Last push:)/u.test(
        line,
      ),
    );
    this.privmsg("NickServ", "PUSH LIST");
    const response = await this.waitFor("push subscription count", (line) =>
      line.includes(" push subscription(s)"),
    );
    const count = / has ([0-9]+) push subscription\(s\)/u.exec(response)?.[1];
    if (count === undefined) {
      throw new Error(`Could not parse push subscription count: ${response}`);
    }
    const endpoints: string[] = [];
    for (let index = 0; index < Number.parseInt(count, 10); index += 1) {
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

  close(): void {
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
