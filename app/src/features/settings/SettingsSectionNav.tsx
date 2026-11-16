import { For, type JSX, onCleanup } from "solid-js";
import { t } from "../../strings";
import { timeTokens } from "../../theme/theme-registry";
import styles from "./SettingsSectionNav.module.css";

export interface SettingsSection<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly labelId: string;
  readonly icon: () => JSX.Element;
}

interface SettingsSectionNavProps<Id extends string> {
  readonly sections: readonly SettingsSection<Id>[];
  readonly current: Id;
  readonly onSelect: (id: Id) => void;
  readonly rail: boolean;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
}

const hoverIntentMs = Number.parseFloat(timeTokens.railHoverIntent);

export function SettingsSectionNav<Id extends string>(
  props: SettingsSectionNavProps<Id>,
) {
  let nav: HTMLElement | undefined;
  let hoverIntent: number | undefined;
  const cancelHoverIntent = () => {
    if (hoverIntent !== undefined) window.clearTimeout(hoverIntent);
    hoverIntent = undefined;
  };
  const expand = () => {
    if (props.rail) props.onExpandedChange(true);
  };
  const collapse = () => {
    cancelHoverIntent();
    if (props.rail) props.onExpandedChange(false);
  };
  const expandedRail = () => props.rail && props.expanded;
  const keyboardFocusInside = () =>
    nav?.querySelector(":focus-visible") != null;
  const moveWithKey = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = props.sections.findIndex(({ id }) => id === props.current);
    const target = sectionIndexForKey(event.key, index, props.sections.length);
    const next = target === undefined ? undefined : props.sections[target];
    if (next === undefined) return;
    event.preventDefault();
    props.onSelect(next.id);
    nav?.querySelector<HTMLElement>(`[data-section="${next.id}"]`)?.focus();
  };
  onCleanup(cancelHoverIntent);
  return (
    <nav
      aria-label={t("settings.sections")}
      class={styles.nav}
      data-expanded={expandedRail() || undefined}
      data-rail={props.rail || undefined}
      onFocusIn={expand}
      onFocusOut={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && nav?.contains(next))) collapse();
      }}
      onPointerEnter={() => {
        cancelHoverIntent();
        if (props.rail) hoverIntent = window.setTimeout(expand, hoverIntentMs);
      }}
      onPointerLeave={() => {
        if (keyboardFocusInside()) cancelHoverIntent();
        else collapse();
      }}
      ref={nav}
    >
      <div class={styles.panel}>
        <For each={props.sections}>
          {(section) => (
            <button
              aria-current={section.id === props.current ? "page" : undefined}
              aria-label={props.rail ? section.label : undefined}
              class={styles.section}
              data-section={section.id}
              onClick={() => {
                props.onSelect(section.id);
                collapse();
              }}
              onKeyDown={moveWithKey}
              tabIndex={section.id === props.current ? 0 : -1}
              title={props.rail && !expandedRail() ? section.label : undefined}
              type="button"
            >
              {section.icon()}
              <span class={styles.label} id={section.labelId}>
                {section.label}
              </span>
            </button>
          )}
        </For>
      </div>
    </nav>
  );
}

function sectionIndexForKey(
  key: string,
  index: number,
  count: number,
): number | undefined {
  switch (key) {
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}
