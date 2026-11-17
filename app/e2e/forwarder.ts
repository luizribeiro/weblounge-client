export class Forwarder {
  readonly #scope: string;

  constructor(scope: string) {
    this.#scope = scope;
  }

  async drop(): Promise<void> {
    await this.#post("/drop");
  }

  /** The app learns of the loss from the close itself, not from a liveness probe. */
  async disconnect(): Promise<void> {
    await this.#post("/disconnect");
  }

  async restore(): Promise<void> {
    await this.#post("/restore");
  }

  async pauseIncoming(): Promise<void> {
    await this.#post("/pause-incoming");
  }

  async resumeIncoming(): Promise<void> {
    await this.#post("/resume-incoming");
  }

  /** Holds this test's incoming traffic from the next line containing `text` until `resumeIncoming`. */
  async holdIncomingContaining(text: string): Promise<void> {
    await this.#post("/hold-incoming", { contains: text });
  }

  async isHoldingIncoming(): Promise<boolean> {
    return (await this.#request("GET", "/held")) === "true";
  }

  async dropIncomingContaining(text: string): Promise<void> {
    await this.#post("/drop-incoming", { contains: text });
  }

  async inject(line: string): Promise<string> {
    return this.#post("/inject", {}, line);
  }

  /** Swaps equal-length text in this test's incoming IRC lines. */
  async rewriteIncomingText(from: string, to: string): Promise<void> {
    await this.#post("/rewrite-text", { from, to });
  }

  async clearTextRewrites(): Promise<void> {
    await this.#post("/clear-text-rewrites");
  }

  #post(
    path: string,
    parameters: Readonly<Record<string, string>> = {},
    body?: string,
  ): Promise<string> {
    return this.#request("POST", path, parameters, body);
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    parameters: Readonly<Record<string, string>> = {},
    body?: string,
  ): Promise<string> {
    const base = process.env.WEBLOUNGE_E2E_FORWARDER_URL;
    if (base === undefined) throw new Error("socket forwarder is unavailable");
    const url = new URL(path, base);
    url.searchParams.set("scope", this.#scope);
    for (const [name, value] of Object.entries(parameters))
      url.searchParams.set(name, value);
    const response = await fetch(url, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok)
      throw new Error(
        `socket forwarder ${path} failed: ${response.status} ${await response.text()}`,
      );
    return response.text();
  }
}
