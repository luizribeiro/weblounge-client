export class Forwarder {
  readonly #scope: string;

  constructor(scope: string) {
    this.#scope = scope;
  }

  async drop(): Promise<void> {
    await this.#post("/drop");
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

  async dropIncomingContaining(text: string): Promise<void> {
    await this.#post("/drop-incoming", { contains: text });
  }

  async inject(line: string): Promise<string> {
    return this.#post("/inject", {}, line);
  }

  async #post(
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
      method: "POST",
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok)
      throw new Error(
        `socket forwarder ${path} failed: ${response.status} ${await response.text()}`,
      );
    return response.text();
  }
}
