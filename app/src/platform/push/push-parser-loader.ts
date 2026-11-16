export interface PushPayloadParser {
  prepare_notification(
    ciphertext: Uint8Array,
    privateKeyPkcs8: Uint8Array,
    auth: Uint8Array,
    networkLabel: string,
    nickname: string,
  ): string;
  counted_notification_body(
    body: string,
    count: number,
    newMessages: string,
  ): string;
}

export type PushParserStage =
  | "parser_cache_lookup"
  | "parser_load"
  | "parser_wasm_load"
  | "decrypt"
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

  async load(
    measure: MeasurePushParserStage = async (_stage, work) => work(),
  ): Promise<PushPayloadParser> {
    let ready = this.#ready;
    if (ready === undefined) {
      ready = this.#load(measure);
      this.#ready = ready;
    }
    try {
      return await measure("parser_load", () => ready);
    } catch (error: unknown) {
      if (this.#ready === ready) this.#ready = undefined;
      throw error;
    }
  }
}
