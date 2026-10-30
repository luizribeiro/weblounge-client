export type BufferSelection =
  | { readonly bufferId: undefined; readonly priority: "none" }
  | {
      readonly bufferId: number;
      readonly priority: "fallback" | "initial" | "explicit";
    };

const priorities: Readonly<Record<BufferSelection["priority"], number>> = {
  none: 0,
  fallback: 1,
  initial: 2,
  explicit: 3,
};

export function selectBuffer(
  current: BufferSelection,
  bufferId: number,
  priority: Exclude<BufferSelection["priority"], "none">,
): BufferSelection {
  return priorities[priority] < priorities[current.priority]
    ? current
    : { bufferId, priority };
}
