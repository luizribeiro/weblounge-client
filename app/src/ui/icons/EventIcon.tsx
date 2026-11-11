import type { SystemLineIcon } from "../../features/conversation/timeline/system-line-words";

const paths: Readonly<Record<SystemLineIcon, string>> = {
  ban: "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0M4.9 4.9l14.2 14.2",
  info: "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0M12 16v-4M12 8h.01",
  invite:
    "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 7l-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",
  join: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3",
  kick: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M17 8l5 5M22 8l-5 5",
  mode: "M20 7h-9M14 17H5M14 17a3 3 0 1 0 6 0a3 3 0 1 0-6 0M4 7a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  nick: "M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16",
  part: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  people:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  quit: "M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04",
  warning:
    "M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01",
};

export function EventIcon(props: {
  readonly class?: string | undefined;
  readonly icon: SystemLineIcon;
  readonly label?: string | undefined;
}) {
  return (
    <svg
      aria-hidden={props.label === undefined ? "true" : undefined}
      aria-label={props.label}
      class={props.class}
      fill="none"
      role={props.label === undefined ? undefined : "img"}
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      viewBox="0 0 24 24"
    >
      <path d={paths[props.icon]} />
    </svg>
  );
}
