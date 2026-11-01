export interface BuildVersion {
  readonly sha: string;
  readonly builtAt: Date | null;
  readonly text: string;
}

export function formatBuildVersion(
  sha: string,
  builtAtEpochSeconds: number,
): BuildVersion {
  if (sha === "dev") return { sha, builtAt: null, text: "weblounge dev" };

  const builtAt = new Date(builtAtEpochSeconds * 1_000);
  if (
    !Number.isFinite(builtAtEpochSeconds) ||
    Number.isNaN(builtAt.valueOf())
  ) {
    throw new Error("invalid build timestamp");
  }
  const minute = builtAt.toISOString().slice(0, 16).replace("T", " ");
  return {
    sha,
    builtAt,
    text: `weblounge ${sha} · built ${minute} UTC`,
  };
}

export const buildVersion = Object.freeze(
  formatBuildVersion(__BUILD_SHA__, Number(__BUILD_TIMESTAMP__)),
);

export function exposeBuildVersion(browserWindow: Window): void {
  browserWindow.weblounge = Object.freeze({ version: buildVersion.text });
}
