export const startupDeadlineMs = 10_000;

export async function withStartupDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutError: () => Error,
  timeoutMs = startupDeadlineMs,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    // wait-ok: this is the product's fixed upper bound for a hosted startup dependency.
    timeout = setTimeout(() => {
      reject(timeoutError());
      controller.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
