export type ViewerCommand =
  | { readonly kind: "close" }
  | { readonly kind: "zoom"; readonly direction: "in" | "out" }
  | { readonly kind: "reset" }
  | { readonly kind: "pan"; readonly x: number; readonly y: number };

const panStep = 80;

const commands: Readonly<Record<string, ViewerCommand>> = {
  Escape: { kind: "close" },
  "+": { kind: "zoom", direction: "in" },
  "=": { kind: "zoom", direction: "in" },
  "-": { kind: "zoom", direction: "out" },
  _: { kind: "zoom", direction: "out" },
  "0": { kind: "reset" },
  ArrowLeft: { kind: "pan", x: panStep, y: 0 },
  ArrowRight: { kind: "pan", x: -panStep, y: 0 },
  ArrowUp: { kind: "pan", x: 0, y: panStep },
  ArrowDown: { kind: "pan", x: 0, y: -panStep },
};

export function viewerCommand(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">,
): ViewerCommand | undefined {
  if (event.altKey || event.ctrlKey || event.metaKey) return undefined;
  return Object.hasOwn(commands, event.key) ? commands[event.key] : undefined;
}
