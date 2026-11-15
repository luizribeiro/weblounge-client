const fnvOffsetBasis = 0x811c9dc5;
const fnvPrime = 0x01000193;

/**
 * Bar widths in `ch` for a redacted message, derived only from its msgid so every device draws
 * the same pattern and nothing reveals the deleted text or its length.
 */
export function redactionBars(msgid: string): readonly number[] {
  const next = mulberry32(fnv1a(msgid));
  const count = 3 + Math.floor(next() * 6);
  return Array.from({ length: count }, () => wordLikeWidth(next(), next()));
}

function wordLikeWidth(first: number, second: number): number {
  return 2 + Math.floor((first + second) * 4);
}

function fnv1a(text: string): number {
  let hash = fnvOffsetBasis;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, fnvPrime);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
