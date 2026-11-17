import { onMount } from "solid-js";
import { Divider } from "./Divider";

/** The list renders only rows in or near the viewport, so mounting is the cue to fill the gap. */
export function GapRow(props: {
  readonly label: string;
  readonly onShown?: (() => void) | undefined;
}) {
  onMount(() => props.onShown?.());
  return <Divider content={{ kind: "gap", label: props.label }} />;
}
