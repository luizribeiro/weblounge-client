import { afterEach, describe, expect, it } from "vitest";
import { currentAppLifecycle, onAppLifecycle } from "./app-lifecycle";

const stops: (() => void)[] = [];

function shellReports(detail: string): void {
  window.dispatchEvent(new CustomEvent("weblounge:lifecycle", { detail }));
}

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  shellReports("foreground");
});

describe("app lifecycle", () => {
  it("starts in the foreground, as a browser always is", () => {
    expect(currentAppLifecycle()).toBe("foreground");
  });

  it("records the shell's lifecycle before notifying each listener", () => {
    const seen: string[] = [];
    for (const name of ["first", "second"])
      stops.push(
        onAppLifecycle((lifecycle) =>
          seen.push(`${name} ${lifecycle} ${currentAppLifecycle()}`),
        ),
      );

    shellReports("background");
    shellReports("foreground");

    expect(seen).toEqual([
      "first background background",
      "second background background",
      "first foreground foreground",
      "second foreground foreground",
    ]);
  });

  it("keeps recording after every listener left", () => {
    const stop = onAppLifecycle(() => {});
    stop();

    shellReports("background");

    expect(currentAppLifecycle()).toBe("background");
  });
});
