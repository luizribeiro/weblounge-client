import {
  openPushDatabase,
  pushStateStore,
  requestResult,
  transactionDone,
} from "./push-database";

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
  write: (entry: PushDeliveryLogEntry) => Promise<void> = appendPushDeliveryLog,
  clocks: PushDeliveryClocks = {
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
  },
): PushDeliveryTrace {
  return new PushDeliveryTrace(version, write, clocks);
}

export async function appendPushDeliveryLog(
  entry: PushDeliveryLogEntry,
  factory: IDBFactory = indexedDB,
): Promise<void> {
  const started = Date.now();
  const database = await openPushDatabase(factory, deliveryLogDeadlineMs);
  try {
    const transaction = database.transaction(pushStateStore, "readwrite");
    const store = transaction.objectStore(pushStateStore);
    const current = [
      ...decodePushDeliveryLog(
        await requestResult(store.get(deliveryLogKey), remaining(started)),
      ),
    ].reverse();
    store.put([...current, entry].slice(-deliveryLogCapacity), deliveryLogKey);
    await transactionDone(transaction, remaining(started));
  } finally {
    database.close();
  }
}

export async function readPushDeliveryLog(
  factory: IDBFactory = indexedDB,
): Promise<readonly PushDeliveryLogEntry[]> {
  const database = await openPushDatabase(factory, 5_000);
  try {
    const transaction = database.transaction(pushStateStore, "readonly");
    const entries = decodePushDeliveryLog(
      await requestResult(
        transaction.objectStore(pushStateStore).get(deliveryLogKey),
        5_000,
      ),
    );
    await transactionDone(transaction, 5_000);
    return entries;
  } finally {
    database.close();
  }
}

export function formatPushDeliveryLog(
  entries: readonly PushDeliveryLogEntry[],
): string {
  if (entries.length === 0) return "No push deliveries recorded.";
  return entries
    .map((entry) => {
      const timing = entry.stages
        .map(({ stage, elapsedMs }) => `${hyphenate(stage)}:${elapsedMs}ms`)
        .join(",");
      const failure =
        entry.failure === undefined
          ? ""
          : ` failure=${hyphenate(entry.failure.stage)}/${entry.failure.errorName}/${hyphenate(entry.failure.reason)}`;
      return `${new Date(entry.atMs).toISOString()} v=${entry.version} outcome=${hyphenate(entry.outcome)} fallback=${entry.fallbackDeadlineFired} elapsed=${entry.elapsedMs}ms stages=${timing || "none"}${failure}`;
    })
    .join("\n");
}

function decodePushDeliveryLog(
  value: unknown,
): readonly PushDeliveryLogEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      const decoded = decodeEntry(entry);
      return decoded === undefined ? [] : [decoded];
    })
    .reverse();
}

function decodeEntry(value: unknown): PushDeliveryLogEntry | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema" in value) ||
    value.schema !== 1 ||
    !("atMs" in value) ||
    !validNumber(value.atMs) ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !("outcome" in value) ||
    !isOutcome(value.outcome) ||
    !("fallbackDeadlineFired" in value) ||
    typeof value.fallbackDeadlineFired !== "boolean" ||
    !("elapsedMs" in value) ||
    !validNumber(value.elapsedMs) ||
    !("stages" in value) ||
    !Array.isArray(value.stages)
  ) {
    return undefined;
  }
  const decodedStages = value.stages.flatMap((timing) => {
    if (
      typeof timing !== "object" ||
      timing === null ||
      !("stage" in timing) ||
      !isStage(timing.stage) ||
      !("elapsedMs" in timing) ||
      !validNumber(timing.elapsedMs)
    ) {
      return [];
    }
    return [{ stage: timing.stage, elapsedMs: timing.elapsedMs }];
  });
  return {
    schema: 1,
    atMs: value.atMs,
    version: value.version,
    outcome: value.outcome,
    fallbackDeadlineFired: value.fallbackDeadlineFired,
    elapsedMs: value.elapsedMs,
    stages: decodedStages,
    ...decodeFailure("failure" in value ? value.failure : undefined),
  };
}

function decodeFailure(
  value: unknown,
): { readonly failure: PushDeliveryFailure } | object {
  if (
    typeof value !== "object" ||
    value === null ||
    !("stage" in value) ||
    !isStage(value.stage) ||
    !("errorName" in value) ||
    typeof value.errorName !== "string" ||
    !safeErrorNames.has(value.errorName) ||
    !("reason" in value) ||
    value.reason !== failureReasons[value.stage]
  ) {
    return {};
  }
  return {
    failure: {
      stage: value.stage,
      errorName: value.errorName,
      reason: value.reason,
    },
  };
}

function safeErrorName(error: unknown): string {
  const name =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
      ? error.name
      : "UnknownError";
  return safeErrorNames.has(name) ? name : "Error";
}

function isOutcome(value: unknown): value is PushDeliveryOutcome {
  return (
    typeof value === "string" && outcomes.has(value as PushDeliveryOutcome)
  );
}

function isStage(value: unknown): value is PushDeliveryStage {
  return typeof value === "string" && stages.has(value as PushDeliveryStage);
}

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function milliseconds(value: number): number {
  return Math.max(0, Math.round(value));
}

function remaining(started: number): number {
  return Math.max(1, deliveryLogDeadlineMs - (Date.now() - started));
}

function hyphenate(value: string): string {
  return value.replaceAll("_", "-");
}
