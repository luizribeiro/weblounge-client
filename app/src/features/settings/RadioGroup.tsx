import { createUniqueId, For, type JSX } from "solid-js";

interface RadioGroupProps<T extends string> {
  readonly class: string | undefined;
  readonly choiceClass: string | undefined;
  readonly labelledBy: string;
  readonly describedBy?: string | undefined;
  readonly values: readonly T[];
  readonly value: T | undefined;
  readonly onChange: (value: T) => void;
  readonly choiceLabel?: ((value: T) => string) | undefined;
  readonly choiceDescribedBy?: ((value: T) => string | undefined) | undefined;
  readonly children: (value: T) => JSX.Element;
  readonly [data: `data-${string}`]: string | undefined;
}

export function RadioGroup<T extends string>(props: RadioGroupProps<T>) {
  const name = createUniqueId();
  return (
    <div
      aria-describedby={props.describedBy}
      aria-labelledby={props.labelledBy}
      class={props.class}
      data-horizontal-scroll={props["data-horizontal-scroll"]}
      role="radiogroup"
    >
      <For each={props.values}>
        {(value) => (
          <label class={props.choiceClass} data-choice={value}>
            <input
              aria-describedby={props.choiceDescribedBy?.(value)}
              aria-label={props.choiceLabel?.(value)}
              checked={value === props.value}
              class="visually-hidden"
              name={name}
              onChange={() => props.onChange(value)}
              type="radio"
              value={value}
            />
            {props.children(value)}
          </label>
        )}
      </For>
    </div>
  );
}
