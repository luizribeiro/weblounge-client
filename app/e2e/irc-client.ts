import { once } from "node:events";
import { createConnection, type Socket } from "node:net";

const host = "127.0.0.1";
const port = 6667;

export class IrcClient {
  readonly #socket: Socket;
  readonly #lines: string[] = [];
  #buffer = "";
  #notify: (() => void) | undefined;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      const lines = this.#buffer.split("\r\n");
      this.#buffer = lines.pop() ?? "";
      this.#lines.push(...lines);
      this.#notify?.();
      this.#notify = undefined;
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
    const client = new IrcClient(socket);
    client.send("CAP LS 302");
    client.send(`NICK ${nickname}`);
    client.send(`USER ${nickname} 0 * :${nickname}`);
    await client.waitFor((line) => line.includes(" CAP * LS "));
    client.send("CAP REQ :sasl echo-message");
    await client.waitFor(
      (line) =>
        line.includes(" CAP * ACK ") &&
        line.includes("sasl") &&
        line.includes("echo-message"),
    );
    client.send("AUTHENTICATE PLAIN");
    await client.waitFor((line) => line === "AUTHENTICATE +");
    const credentials = Buffer.from(`\0${account}\0${password}`).toString(
      "base64",
    );
    client.send(`AUTHENTICATE ${credentials}`);
    await client.waitFor((line) => line.includes(" 903 "));
    client.send("CAP END");
    await client.waitFor((line) => line.includes(" 001 "));
    client.send(`JOIN ${channel}`);
    await client.waitFor(
      (line) => line.includes(`!`) && line.includes(` JOIN ${channel}`),
    );
    return client;
  }

  privmsg(channel: string, text: string): void {
    this.send(`PRIVMSG ${channel} :${text}`);
  }

  async privmsgConfirmed(channel: string, text: string): Promise<void> {
    this.privmsg(channel, text);
    await this.waitFor((line) => line.includes(` PRIVMSG ${channel} :${text}`));
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

  private send(line: string): void {
    this.#socket.write(`${line}\r\n`);
  }

  private async waitFor(predicate: (line: string) => boolean): Promise<string> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const index = this.#lines.findIndex(predicate);
      if (index !== -1) return this.#lines.splice(index, 1)[0] ?? "";
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 100);
        this.#notify = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
    }
    throw new Error(
      `IRC response timed out; received ${this.#lines.join(" | ")}`,
    );
  }
}
