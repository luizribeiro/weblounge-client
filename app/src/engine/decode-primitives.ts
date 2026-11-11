export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function decodeArray<T>(
  value: unknown,
  decode: (item: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const decoded: T[] = [];
  for (const item of value) {
    const result = decode(item);
    if (result === undefined) return undefined;
    decoded.push(result);
  }
  return decoded;
}

export function isOneOf<const T extends string>(
  value: unknown,
  choices: readonly T[],
): value is T {
  return (
    typeof value === "string" && choices.some((choice) => choice === value)
  );
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function decodeNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function decodeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
