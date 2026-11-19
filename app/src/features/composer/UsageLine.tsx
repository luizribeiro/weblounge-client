import { Index } from "solid-js";
import type { CommandUsage } from "../../engine/protocol";
import { Line } from "../../ui/Line";
import styles from "../conversation/SimpleComposer.module.css";

type CommandArgument = CommandUsage["arguments"][number];

interface UsageLineProps {
  readonly id: string;
  readonly usage: CommandUsage;
}

export function UsageLine(props: UsageLineProps) {
  return (
    <Line
      class={styles.hint}
      data-command-usage={props.usage.name}
      id={props.id}
    >
      {`/${props.usage.name}`}
      <Index each={props.usage.arguments}>
        {(argument, index) => (
          <>
            {" "}
            <span
              class={
                index === props.usage.active_argument
                  ? styles.activeArgument
                  : undefined
              }
              data-active-argument={
                index === props.usage.active_argument || undefined
              }
            >
              {placeholder(argument())}
            </span>
          </>
        )}
      </Index>
    </Line>
  );
}

function placeholder(argument: CommandArgument): string {
  return argument.required ? `<${argument.name}>` : `[${argument.name}]`;
}
