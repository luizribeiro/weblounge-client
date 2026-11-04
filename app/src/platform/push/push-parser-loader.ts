export interface PushPayloadParser {
  parse_push_payload_json(input: string): string;
}

export class PushParserLoader {
  readonly #load: () => Promise<PushPayloadParser>;
  #ready: Promise<PushPayloadParser> | undefined;

  constructor(load: () => Promise<PushPayloadParser>) {
    this.#load = load;
  }

  async parse(line: string): Promise<string> {
    let ready = this.#ready;
    if (ready === undefined) {
      ready = this.#load();
      this.#ready = ready;
    }
    try {
      return (await ready).parse_push_payload_json(line);
    } catch (error: unknown) {
      if (this.#ready === ready) this.#ready = undefined;
      throw error;
    }
  }
}
