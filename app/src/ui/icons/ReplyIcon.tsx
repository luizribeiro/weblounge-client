export function ReplyIcon(props: { readonly class?: string | undefined }) {
  return (
    <svg
      aria-hidden="true"
      class={props.class}
      data-icon="reply"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 6 6v3" />
    </svg>
  );
}
