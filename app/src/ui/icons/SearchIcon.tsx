interface SearchIconProps {
  readonly class?: string | undefined;
}

export function SearchIcon(props: SearchIconProps) {
  return (
    <svg
      aria-hidden="true"
      class={props.class}
      data-icon="search"
      viewBox="0 0 24 24"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
