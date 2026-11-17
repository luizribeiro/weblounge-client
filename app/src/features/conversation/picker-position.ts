interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

interface Viewport {
  readonly innerWidth: number;
  readonly innerHeight: number;
}

const gap = 6;
const inset = 8;

export type PickerAlignment = "start" | "end";

/** Opens below its invoker, aligned to its `align` edge, and flips above when the viewport runs out. */
export function pickerPosition(
  invoker: Box,
  picker: Size,
  viewport: Viewport,
  align: PickerAlignment = "end",
): { readonly left: number; readonly top: number } {
  const below = invoker.bottom + gap;
  const above = invoker.top - gap - picker.height;
  const fitsBelow = below + picker.height <= viewport.innerHeight - inset;
  const top = fitsBelow || above < inset ? below : above;
  return {
    left: clamp(
      align === "end" ? invoker.right - picker.width : invoker.left,
      inset,
      viewport.innerWidth - picker.width - inset,
    ),
    top: clamp(top, inset, viewport.innerHeight - picker.height - inset),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
