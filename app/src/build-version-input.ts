const RELEASE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(\+[1-9]\d*)?$/u;

type BuildEnvironment = Readonly<Record<string, string | undefined>>;

// Only release builds are handed a version (design 37); every other build has none.
export function buildVersionFromEnv(
  mode: string,
  environment: BuildEnvironment,
): string | null {
  const version = environment.WEBLOUNGE_VERSION;
  if (mode !== "production" || version === undefined || version === "")
    return null;
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(
      `WEBLOUNGE_VERSION ${version} is not X.Y.Z or X.Y.Z+N (see apps/tauri/release/describe-version.mjs)`,
    );
  }
  return version;
}
