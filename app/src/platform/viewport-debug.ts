type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const flagParameter = "debug";
const flagValue = "viewport";
const storageKey = "weblounge.debug.viewport";

// Home Screen apps launch at the manifest start_url and hosted sign-in
// redirects drop the query, so the flag must outlive the URL that set it.
export function viewportDebugRequested(
  url: URL,
  storage: FlagStorage | null,
): boolean {
  const requested = url.searchParams.get(flagParameter);
  return (
    attempt(() => {
      if (requested === flagValue) storage?.setItem(storageKey, "on");
      if (requested === "off") storage?.removeItem(storageKey);
      return storage?.getItem(storageKey) === "on";
    }) === true || requested === flagValue
  );
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
