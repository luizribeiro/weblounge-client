import type {
  Reporter,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

const actionLimit = 40;
const lineLimit = 240;
const reportedCategories = new Set(["expect", "pw:api", "test.step"]);

function flattenSteps(steps: readonly TestStep[]): TestStep[] {
  return steps.flatMap((step) => [step, ...flattenSteps(step.steps)]);
}

function compact(text: string): string {
  const singleLine = text.replaceAll(/\s+/gu, " ").trim();
  return singleLine.length <= lineLimit
    ? singleLine
    : `${singleLine.slice(0, lineLimit - 1)}…`;
}

export default class FailureDiagnosticsReporter implements Reporter {
  printsToStdio(): boolean {
    return true;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === test.expectedStatus) return;

    const actions = flattenSteps(result.steps)
      .filter((step) => reportedCategories.has(step.category))
      .sort(
        (first, second) =>
          first.startTime.getTime() - second.startTime.getTime(),
      )
      .slice(-actionLimit);
    const lines = actions.map((step) => {
      const elapsed = step.startTime.getTime() - result.startTime.getTime();
      const subtitle = step.subtitle === undefined ? "" : ` — ${step.subtitle}`;
      const status = step.error === undefined ? "" : " [failed]";
      return `  +${elapsed}ms ${step.category}: ${compact(`${step.title}${subtitle}`)}${status}`;
    });
    const omitted = Math.max(
      0,
      flattenSteps(result.steps).filter((step) =>
        reportedCategories.has(step.category),
      ).length - actions.length,
    );
    const prefix =
      omitted === 0 ? "" : ` (last ${actionLimit}; ${omitted} omitted)`;
    process.stdout.write(
      `\nFailure action timeline${prefix}: ${test.titlePath().join(" > ")}\n${lines.join("\n")}\n`,
    );
  }
}
