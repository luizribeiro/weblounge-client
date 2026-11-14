import { RadioGroup } from "./RadioGroup";
import styles from "./SegmentedChoice.module.css";

interface SegmentedChoiceProps<T extends string> {
  readonly labelledBy: string;
  readonly describedBy?: string | undefined;
  readonly values: readonly T[];
  readonly label: (value: T) => string;
  readonly value: T | undefined;
  readonly onChange: (value: T) => void;
}

export function SegmentedChoice<T extends string>(
  props: SegmentedChoiceProps<T>,
) {
  return (
    <RadioGroup
      choiceClass={styles.choice}
      class={styles.group}
      describedBy={props.describedBy}
      labelledBy={props.labelledBy}
      onChange={props.onChange}
      value={props.value}
      values={props.values}
    >
      {props.label}
    </RadioGroup>
  );
}
