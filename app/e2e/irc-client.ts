import { once } from "node:events";
import { createConnection, type Socket } from "node:net";

const host = "127.0.0.1";
const port = Number(process.env.WEBLOUNGE_E2E_IRC_PORT ?? 6667);

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
    const socket = createConnection({ host, port });
    await once(socket, "connect");
    const client = new IrcClient(socket, nickname);
    client.send("CAP LS 302");
    client.send(`NICK ${nickname}`);
    client.send(`USER ${nickname} 0 * :${nickname}`);
    await client.waitFor((line) => line.includes(" CAP * LS "));
    client.send("CAP REQ :batch draft/multiline echo-message sasl server-time");
    await client.waitFor(
      (line) =>
        line.includes(" CAP * ACK ") &&
        line.includes("batch") &&
        line.includes("draft/multiline") &&
        line.includes("sasl") &&
        line.includes("echo-message") &&
        line.includes("server-time"),
    );
    client.send("AUTHENTICATE PLAIN");
    await client.waitFor((line) => line === "AUTHENTICATE +");
    const credentials = Buffer.from(`\0${account}\0${password}`).toString(
      "base64",
    );
    client.send(`AUTHENTICATE ${credentials}`);
    await client.waitFor((line) => line.includes(" 903 "));
    client.send("CAP END");
    const welcome = await client.waitFor((line) => line.includes(" 001 "));
    client.#nickname = welcome.match(/ 001 (\S+) /u)?.[1] ?? nickname;
    client.send(`JOIN ${channel}`);
    await client.waitFor(
      (line) => line.includes(`!`) && line.includes(` JOIN ${channel}`),
    );
    return client;
  }

  get nickname(): string {
    return this.#nickname;
  }

  privmsg(channel: string, text: string): void {
    this.send(`PRIVMSG ${channel} :${text}`);
  }

  async privmsgConfirmed(channel: string, text: string): Promise<string> {
    this.privmsg(channel, text);
    return this.waitFor((line) =>
      line.includes(` PRIVMSG ${channel} :${text}`),
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
      await this.waitFor((line) =>
        line.includes(` PRIVMSG ${channel} :${finalText}`),
      );
  }

  async actionConfirmed(channel: string, text: string): Promise<void> {
    await this.privmsgConfirmed(channel, `\u0001ACTION ${text}\u0001`);
  }

  async mode(target: string, change: string, nick?: string): Promise<void> {
    const argument = nick === undefined ? "" : ` ${nick}`;
    this.send(`MODE ${target} ${change}${argument}`);
    await this.waitFor((line) =>
      line.includes(` MODE ${target} ${change}${argument}`),
    );
  }

  async part(channel: string): Promise<void> {
    this.send(`PART ${channel} :screenshot seed complete`);
    await this.waitFor((line) => line.includes(` PART ${channel} `));
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

  private async waitFor(predicate: (line: string) => boolean): Promise<string> {
    const signal = AbortSignal.timeout(5_000);
    while (!signal.aborted) {
      const index = this.#lines.findIndex(predicate);
      if (index !== -1) return this.#lines.splice(index, 1)[0] ?? "";
      await once(this.#socket, "data", { signal });
    }
    throw new Error(
      `IRC response timed out; received ${this.#lines.join(" | ")}`,
    );
  }
}
