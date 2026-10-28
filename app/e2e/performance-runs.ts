export const performanceRunCount = 5;

export async function repeatScenario<T>(
  scenario: () => Promise<T>,
): Promise<readonly T[]> {
  const runs: T[] = [];
  for (let index = 0; index < performanceRunCount; index += 1) {
    runs.push(await scenario());
  }
  return runs;
}

export function summarizeFrameRuns(frameRuns: readonly number[][]) {
  const runP95FrameMs = frameRuns.map((frames) => percentile(frames, 0.95));
  return {
    medianFrameMs: percentile(runP95FrameMs, 0.5),
    p95OfRunsFrameMs: percentile(runP95FrameMs, 0.95),
    runP95FrameMs,
  };
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}
