export function CloseIcon(props: { readonly class?: string | undefined }) {
  return (
    <svg
      aria-hidden="true"
      class={props.class}
      data-icon="close"
      viewBox="0 0 24 24"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
