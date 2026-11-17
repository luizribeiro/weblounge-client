import { followAnchor } from "../../ui/follow-anchor";
import { type PickerAlignment, pickerPosition } from "./picker-position";

/**
 * Places `popover` on `invoker` through the `${cssPrefix}-left`/`-top` properties and keeps it
 * there; `lose` runs when the invoker scrolls away or detaches. Returns the function that stops
 * following.
 */
export function anchorPopover(
  popover: HTMLElement,
  invoker: HTMLElement,
  cssPrefix: string,
  lose: () => void,
  align: PickerAlignment = "end",
): () => void {
  const place = () => {
    const position = pickerPosition(
      invoker.getBoundingClientRect(),
      popover.getBoundingClientRect(),
      window,
      align,
    );
    popover.style.setProperty(`${cssPrefix}-left`, `${position.left}px`);
    popover.style.setProperty(`${cssPrefix}-top`, `${position.top}px`);
  };
  place();
  return followAnchor(invoker, place, lose);
}
