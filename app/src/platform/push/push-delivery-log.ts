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
  | "database_transaction"
  | "route_lookup"
  | "key_lookup"
  | "decrypt"
  | "parser_cache_lookup"
  | "parser_load"
  | "parser_wasm_load"
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

export interface PushDeliveryEnvironment {
  readonly locksAvailable?: true;
  readonly visibility?: "hidden" | "visible";
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
  readonly deferred: boolean;
  readonly stages: readonly PushDeliveryStageTiming[];
  readonly locksAvailable?: true;
  readonly visibility?: "hidden" | "visible";
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
  "database_transaction",
  "route_lookup",
  "key_lookup",
  "decrypt",
  "parser_cache_lookup",
  "parser_load",
  "parser_wasm_load",
  "parse",
  "notification_show",
  "fallback_dismiss",
  "state_commit",
  "delivery",
]);
const safeErrorNames = new Set([
  "AbortError",
  "CompileError",
  "ConstraintError",
  "DataError",
  "DatabaseTimeoutError",
  "Error",
  "InvalidAccessError",
  "InvalidStateError",
  "LinkError",
  "NetworkError",
  "NotFoundError",
  "NotReadableError",
  "OperationError",
  "QuotaExceededError",
  "ReadOnlyError",
  "RuntimeError",
  "SecurityError",
  "SyntaxError",
  "TimeoutError",
  "TransactionInactiveError",
  "TypeError",
  "UnknownError",
  "VersionError",
]);
const failureReasons: Readonly<Record<PushDeliveryStage, string>> = {
  envelope_decode: "invalid_envelope",
  database_open: "push_database_unavailable",
  database_transaction: "push_database_transaction_failed",
  route_lookup: "route_unavailable",
  key_lookup: "route_key_unavailable",
  decrypt: "decrypt_failed",
  parser_cache_lookup: "parser_cache_unavailable",
  parser_load: "parser_unavailable",
  parser_wasm_load: "parser_wasm_load_failed",
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
  #environment: PushDeliveryEnvironment = {};

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
      if (this.#candidate?.error !== error) this.#candidate = { stage, error };
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

  setEnvironment(environment: PushDeliveryEnvironment): void {
    this.#environment = environment;
  }

  complete(completion: PushDeliveryCompletion): Promise<void> {
    return this.#write({
      schema: 1,
      atMs: this.#startedAtMs,
      version: this.#version,
      outcome: completion.outcome,
      fallbackDeadlineFired: completion.fallbackDeadlineFired,
      elapsedMs: milliseconds(completion.elapsedMs),
      deferred: false,
      stages: [...this.#stageElapsed].map(([stage, elapsedMs]) => ({
        stage,
        elapsedMs: milliseconds(elapsedMs),
      })),
      ...this.#environment,
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

type PersistPushDeliveryEntries = (
  entries: readonly PushDeliveryLogEntry[],
  factory: IDBFactory,
) => Promise<void>;

export class PushDeliveryLogWriter {
  readonly #persist: PersistPushDeliveryEntries;
  #pending: readonly PushDeliveryLogEntry[] = [];
  #tail = Promise.resolve();

  constructor(persist: PersistPushDeliveryEntries = persistPushDeliveryLog) {
    this.#persist = persist;
  }

  append(
    entry: PushDeliveryLogEntry,
    factory: IDBFactory = indexedDB,
  ): Promise<void> {
    return this.#enqueue(async () => {
      try {
        await this.#persist(
          [...this.#pending, { ...entry, deferred: false }],
          factory,
        );
        this.#pending = [];
      } catch (error: unknown) {
        this.#pending = [...this.#pending, { ...entry, deferred: true }].slice(
          -deliveryLogCapacity,
        );
        throw error;
      }
    });
  }

  flush(factory: IDBFactory = indexedDB): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#pending.length === 0) return;
      await this.#persist(this.#pending, factory);
      this.#pending = [];
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.#tail.then(operation);
    this.#tail = current.catch(() => undefined);
    return current;
  }
}

const deliveryLogWriter = new PushDeliveryLogWriter();

export async function appendPushDeliveryLog(
  entry: PushDeliveryLogEntry,
  factory: IDBFactory = indexedDB,
): Promise<void> {
  return deliveryLogWriter.append(entry, factory);
}

export async function flushDeferredPushDeliveryLog(
  factory: IDBFactory = indexedDB,
): Promise<void> {
  return deliveryLogWriter.flush(factory);
}

async function persistPushDeliveryLog(
  entries: readonly PushDeliveryLogEntry[],
  factory: IDBFactory,
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
    store.put(
      [...current, ...entries].slice(-deliveryLogCapacity),
      deliveryLogKey,
    );
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
      const environment = `${entry.locksAvailable === true ? " locks=available" : ""}${entry.visibility === undefined ? "" : ` visibility=${entry.visibility}`}`;
      return `${new Date(entry.atMs).toISOString()} v=${entry.version} outcome=${hyphenate(entry.outcome)} fallback=${entry.fallbackDeadlineFired} elapsed=${entry.elapsedMs}ms deferred=${entry.deferred}${environment} stages=${timing || "none"}${failure}`;
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
    !("deferred" in value) ||
    typeof value.deferred !== "boolean" ||
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
    deferred: value.deferred,
    stages: decodedStages,
    ...decodeEnvironment(value),
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

function decodeEnvironment(
  value: Record<string, unknown>,
): PushDeliveryEnvironment {
  return {
    ...(value.locksAvailable === true ? { locksAvailable: true as const } : {}),
    ...(value.visibility === "hidden" || value.visibility === "visible"
      ? { visibility: value.visibility }
      : {}),
  };
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
