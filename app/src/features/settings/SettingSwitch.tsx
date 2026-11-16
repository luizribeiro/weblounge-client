import styles from "./SettingSwitch.module.css";

interface SettingSwitchProps {
  readonly labelledBy: string;
  readonly describedBy?: string | undefined;
  readonly checked: boolean | undefined;
  readonly onChange: (checked: boolean) => void;
}

export function SettingSwitch(props: SettingSwitchProps) {
  return (
    <button
      aria-checked={props.checked === true}
      aria-describedby={props.describedBy}
      aria-labelledby={props.labelledBy}
      class={styles.switch}
      disabled={props.checked === undefined}
      onClick={() => props.onChange(props.checked !== true)}
      role="switch"
      type="button"
    >
      <span aria-hidden="true" class={styles.knob} />
    </button>
  );
}
