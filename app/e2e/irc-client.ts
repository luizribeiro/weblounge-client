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
    client.send("CAP REQ :sasl echo-message server-time");
    await client.waitFor(
      (line) =>
        line.includes(" CAP * ACK ") &&
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
