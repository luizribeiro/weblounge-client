import { nickPaletteSize } from "../../theme/theme-registry";

export function nickColor(index: number): string {
  return `var(--wl-nick-${index % nickPaletteSize})`;
}
