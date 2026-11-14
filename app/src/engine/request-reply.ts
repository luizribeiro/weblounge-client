import type { EngineClient } from "./EngineClient";
import type { EngineClientMessage, EngineRequestEnvelope } from "./protocol";

export class RequestAbortedError extends Error {
  constructor() {
    super("request aborted");
    this.name = "RequestAbortedError";
  }
}

/**
 * Sends one request and resolves with the value of the first correlated reply that `reply`
 * matches. The request's rejection, or `signal` aborting first, rejects the promise.
 */
export function requestReply<T>(
  engine: EngineClient,
  request: EngineRequestEnvelope["request"],
  reply: (
    message: EngineClientMessage,
    commandId: string,
  ) => { readonly value: T } | undefined,
  signal?: AbortSignal,
): Promise<T> {
  const commandId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new RequestAbortedError());
      return;
    }
    const finish = () => {
      unsubscribe();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(new RequestAbortedError());
    };
    const unsubscribe = engine.subscribe((message) => {
      const matched = reply(message, commandId);
      if (matched === undefined) return;
      finish();
      resolve(matched.value);
    });
    signal?.addEventListener("abort", abort, { once: true });
    void engine.send({ id: commandId, request }).catch((error: unknown) => {
      finish();
      reject(error);
    });
  });
}
