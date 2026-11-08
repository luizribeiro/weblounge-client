export type PushDeliveryOutcome =
  | "real_notification"
  | "deadline_generic_replaced"
  | "final_generic"
  | "silent_control"
  | "dismissed_fallback";

export type PushDeliveryStage =
  | "envelope_decode"
  | "database_open"
  | "route_lookup"
  | "key_lookup"
  | "decrypt"
  | "parser_load"
  | "parse"
  | "notification_show"
  | "fallback_dismiss"
  | "state_commit"
  | "delivery";

export interface PushDeliveryCompletion {
  readonly outcome: PushDeliveryOutcome;
  readonly fallbackDeadlineFired: boolean;
  readonly elapsedMs: number;
}

interface PushDeliveryStageTiming {
  readonly stage: PushDeliveryStage;
  readonly elapsedMs: number;
}

interface PushDeliveryFailure {
  readonly stage: PushDeliveryStage;
  readonly errorName: string;
  readonly reason: string;
}

export interface PushDeliveryLogEntry {
  readonly schema: 1;
  readonly atMs: number;
  readonly version: string;
  readonly outcome: PushDeliveryOutcome;
  readonly fallbackDeadlineFired: boolean;
  readonly elapsedMs: number;
  readonly stages: readonly PushDeliveryStageTiming[];
  readonly failure?: PushDeliveryFailure;
}

interface PushDeliveryClocks {
  readonly monotonicNow: () => number;
  readonly wallNow: () => number;
}

const deliveryLogKey = "push-delivery-log";
const deliveryLogCapacity = 50;
const deliveryLogDeadlineMs = 250;
const outcomes = new Set<PushDeliveryOutcome>([
  "real_notification",
  "deadline_generic_replaced",
  "final_generic",
  "silent_control",
  "dismissed_fallback",
]);
const stages = new Set<PushDeliveryStage>([
  "envelope_decode",
  "database_open",
  "route_lookup",
  "key_lookup",
  "decrypt",
  "parser_load",
  "parse",
  "notification_show",
  "fallback_dismiss",
  "state_commit",
  "delivery",
]);
const safeErrorNames = new Set([
  "AbortError",
  "DataError",
  "DatabaseTimeoutError",
  "Error",
  "InvalidAccessError",
  "NetworkError",
  "NotFoundError",
  "OperationError",
  "QuotaExceededError",
  "SecurityError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "UnknownError",
]);
const failureReasons: Readonly<Record<PushDeliveryStage, string>> = {
  envelope_decode: "invalid_envelope",
  database_open: "push_database_unavailable",
  route_lookup: "route_unavailable",
  key_lookup: "route_key_unavailable",
  decrypt: "decrypt_failed",
  parser_load: "parser_unavailable",
  parse: "payload_parse_failed",
  notification_show: "notification_show_failed",
  fallback_dismiss: "fallback_dismiss_failed",
  state_commit: "state_commit_failed",
  delivery: "delivery_failed",
};

export class PushDeliveryTrace {
  readonly #version: string;
  readonly #write: (entry: PushDeliveryLogEntry) => Promise<void>;
  readonly #clocks: PushDeliveryClocks;
  readonly #startedAtMs: number;
  readonly #stageElapsed = new Map<PushDeliveryStage, number>();
  #candidate:
    | { readonly stage: PushDeliveryStage; readonly error: unknown }
    | undefined;
  #failure: PushDeliveryFailure | undefined;

  constructor(
    version: string,
    write: (entry: PushDeliveryLogEntry) => Promise<void>,
    clocks: PushDeliveryClocks,
  ) {
    this.#version = version;
    this.#write = write;
    this.#clocks = clocks;
    this.#startedAtMs = clocks.wallNow();
  }

  async measure<T>(
    stage: PushDeliveryStage,
    work: () => T | Promise<T>,
  ): Promise<T> {
    const started = this.#clocks.monotonicNow();
    try {
      return await work();
    } catch (error: unknown) {
      this.#candidate = { stage, error };
      throw error;
    } finally {
      const elapsed = this.#clocks.monotonicNow() - started;
      this.#stageElapsed.set(
        stage,
        (this.#stageElapsed.get(stage) ?? 0) + elapsed,
      );
    }
  }

  fail(error: unknown): void {
    const candidate = this.#candidate;
    const stage =
      candidate !== undefined && candidate.error === error
        ? candidate.stage
        : "delivery";
    this.#failure = {
      stage,
      errorName: safeErrorName(error),
      reason: failureReasons[stage],
    };
  }

  complete(completion: PushDeliveryCompletion): Promise<void> {
    return this.#write({
      schema: 1,
      atMs: this.#startedAtMs,
      version: this.#version,
      outcome: completion.outcome,
      fallbackDeadlineFired: completion.fallbackDeadlineFired,
      elapsedMs: milliseconds(completion.elapsedMs),
      stages: [...this.#stageElapsed].map(([stage, elapsedMs]) => ({
        stage,
        elapsedMs: milliseconds(elapsedMs),
      })),
      ...(this.#failure === undefined ? {} : { failure: this.#failure }),
    });
  }
}

export function createPushDeliveryTrace(
  version: string,
  write: (entry: PushDeliveryLogEntry) => Promise<void>,
  clocks: PushDeliveryClocks = {
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
  },
): PushDeliveryTrace {
  return new PushDeliveryTrace(version, write, clocks);
}
