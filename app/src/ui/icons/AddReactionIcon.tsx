interface AddReactionIconProps {
  readonly class?: string | undefined;
}

export function AddReactionIcon(props: AddReactionIconProps) {
  return (
    <svg
      aria-hidden="true"
      class={props.class}
      data-icon="add-reaction"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
    >
      <circle cx="11" cy="13" r="8" />
      <path d="M8 15s1 1.5 3 1.5 3-1.5 3-1.5" />
      <path d="M8.5 10.5h.01M13.5 10.5h.01" />
      <path d="M19 2v5M16.5 4.5h5" />
    </svg>
  );
}
