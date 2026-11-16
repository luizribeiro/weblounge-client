import { createUniqueId, type JSX } from "solid-js";
import styles from "./SettingRow.module.css";

export interface SettingControlIds {
  readonly labelledBy: string;
  readonly describedBy: string;
}

interface SettingRowProps {
  readonly label: string;
  readonly description: string;
  readonly control: "choice" | "switch";
  readonly children: (ids: SettingControlIds) => JSX.Element;
}

export function SettingRow(props: SettingRowProps) {
  const ids: SettingControlIds = {
    labelledBy: createUniqueId(),
    describedBy: createUniqueId(),
  };
  return (
    <div class={styles.row} data-control={props.control}>
      <div class={styles.text}>
        <span class={styles.label} id={ids.labelledBy}>
          {props.label}
        </span>
        <span class={styles.description} id={ids.describedBy}>
          {props.description}
        </span>
      </div>
      {props.children(ids)}
    </div>
  );
}
