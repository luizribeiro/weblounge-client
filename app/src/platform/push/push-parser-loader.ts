export interface PushPayloadParser {
  parse_push_payload_json(input: string): string;
}

export type PushParserStage =
  | "parser_cache_lookup"
  | "parser_load"
  | "parser_wasm_load"
  | "parse";
export type MeasurePushParserStage = <T>(
  stage: PushParserStage,
  work: () => T | Promise<T>,
) => Promise<T>;

export class PushParserLoader {
  readonly #load: (
    measure: MeasurePushParserStage,
  ) => Promise<PushPayloadParser>;
  #ready: Promise<PushPayloadParser> | undefined;

  constructor(
    load: (measure: MeasurePushParserStage) => Promise<PushPayloadParser>,
  ) {
    this.#load = load;
  }

  async parse(
    line: string,
    measure: MeasurePushParserStage = async (_stage, work) => work(),
  ): Promise<string> {
    let ready = this.#ready;
    if (ready === undefined) {
      ready = this.#load(measure);
      this.#ready = ready;
    }
    try {
      const loaded = await measure("parser_load", () => ready);
      return await measure("parse", () => loaded.parse_push_payload_json(line));
    } catch (error: unknown) {
      if (this.#ready === ready) this.#ready = undefined;
      throw error;
    }
  }
}
