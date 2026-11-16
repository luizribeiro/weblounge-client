export type TauriInvoke = (
  command: string,
  args?: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export function tauriInvoke(
  scope: Pick<Window, "__TAURI_INTERNALS__">,
): TauriInvoke | undefined {
  const internals = scope.__TAURI_INTERNALS__;
  if (
    typeof internals !== "object" ||
    internals === null ||
    !("invoke" in internals) ||
    typeof internals.invoke !== "function"
  )
    return undefined;
  const call = internals.invoke;
  return (command, args) => {
    // A shell shim may throw synchronously; callers handle failures in one place, the rejection.
    try {
      return Promise.resolve(Reflect.apply(call, internals, [command, args]));
    } catch (error: unknown) {
      return Promise.reject(error);
    }
  };
}
