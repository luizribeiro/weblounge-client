export interface PointerSample {
  readonly x: number;
  readonly time: number;
}

const releaseVelocityWindow = 100;

export function recentPointerSamples(
  samples: readonly PointerSample[],
  x: number,
  time: number,
): readonly PointerSample[] {
  return [...samples, { time, x }].filter(
    (sample) => time - sample.time <= releaseVelocityWindow,
  );
}

export function releaseVelocityX(
  samples: readonly PointerSample[],
  x: number,
  time: number,
): number {
  const oldest = recentPointerSamples(samples, x, time)[0];
  const elapsed = time - (oldest?.time ?? time);
  if (oldest === undefined || elapsed <= 0) return 0;
  return (x - oldest.x) / elapsed;
}
