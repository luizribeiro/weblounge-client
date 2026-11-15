interface MoreIconProps {
  readonly class?: string | undefined;
}

export function MoreIcon(props: MoreIconProps) {
  return (
    <svg
      aria-hidden="true"
      class={props.class}
      data-icon="more"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <circle cx="5" cy="12" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="19" cy="12" r="1.75" />
    </svg>
  );
}
