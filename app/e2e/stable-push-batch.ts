export async function deliverStablePushBatch<T>(
  plaintexts: readonly string[],
  encrypt: (plaintexts: readonly string[]) => Promise<readonly T[]>,
  deliver: (envelope: T) => Promise<void>,
): Promise<void> {
  const envelopes = await encrypt(plaintexts);
  if (envelopes.length !== plaintexts.length) {
    throw new Error("push fixture did not encrypt every plaintext");
  }
  for (const envelope of envelopes) await deliver(envelope);
}
