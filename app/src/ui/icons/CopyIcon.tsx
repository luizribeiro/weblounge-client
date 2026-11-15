export function CopyIcon(props: { readonly class?: string | undefined }) {
  return (
    <svg
      aria-hidden="true"
      class={props.class}
      data-icon="copy"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
    >
      <rect height="12" rx="2" width="12" x="9" y="9" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}
