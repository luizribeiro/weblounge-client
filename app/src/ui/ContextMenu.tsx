import { createEffect, For, onCleanup, Show } from "solid-js";
import styles from "./ContextMenu.module.css";
import type { ContextMenuRequest } from "./context-menu";

export interface ContextMenuItem {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
}

interface ContextMenuProps {
  readonly label: string;
  readonly request: ContextMenuRequest | undefined;
  readonly items: readonly ContextMenuItem[];
  readonly destructiveItems?: readonly ContextMenuItem[] | undefined;
  readonly onDismiss: () => void;
}

export function ContextMenu(props: ContextMenuProps) {
  let menu: HTMLDivElement | undefined;

  createEffect(() => {
    if (props.request === undefined) return;
    const dismiss = (event: PointerEvent) => {
      if (menu?.contains(event.target as Node) !== true) props.onDismiss();
    };
    document.addEventListener("pointerdown", dismiss);
    onCleanup(() => document.removeEventListener("pointerdown", dismiss));
  });

  const dismiss = (restoreFocus: boolean) => {
    const invoker = props.request?.invoker;
    props.onDismiss();
    if (restoreFocus) invoker?.focus({ preventScroll: true });
  };
  const select = (item: ContextMenuItem) => {
    dismiss(true);
    item.onSelect();
  };
  const items = () => [...props.items, ...(props.destructiveItems ?? [])];
  const move = (offset: -1 | 1) => {
    const items = menuItems(menu);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(current + offset + items.length) % items.length]?.focus();
  };

  return (
    <Show when={props.request} keyed>
      {(request) => (
        <div
          aria-label={props.label}
          class={styles.menu}
          data-context-menu="true"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              move(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              const index = menuItems(menu).indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const item = items()[index];
              if (item !== undefined) select(item);
            } else if (event.key === "Escape") {
              event.preventDefault();
              dismiss(true);
            }
          }}
          ref={(element) => {
            menu = element;
            const position = contextMenuPosition(
              request,
              element.getBoundingClientRect(),
              window,
            );
            element.style.setProperty(
              "--wl-context-menu-left",
              `${position.left}px`,
            );
            element.style.setProperty(
              "--wl-context-menu-top",
              `${position.top}px`,
            );
            queueMicrotask(() => menuItems(element)[0]?.focus());
          }}
          role="menu"
        >
          <For each={props.items}>
            {(item) => menuItem(item, false, select)}
          </For>
          <Show when={(props.destructiveItems?.length ?? 0) > 0}>
            <hr class={styles.separator} />
            <For each={props.destructiveItems}>
              {(item) => menuItem(item, true, select)}
            </For>
          </Show>
        </div>
      )}
    </Show>
  );
}

function menuItem(
  item: ContextMenuItem,
  danger: boolean,
  select: (item: ContextMenuItem) => void,
) {
  return (
    <button
      class={`${styles.item} ${danger ? styles.danger : ""}`}
      onClick={() => select(item)}
      role="menuitem"
      tabIndex={-1}
      type="button"
    >
      {item.label}
    </button>
  );
}

function menuItems(menu: HTMLDivElement | undefined): HTMLButtonElement[] {
  return menu === undefined
    ? []
    : [...menu.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
}

export function contextMenuPosition(
  request: Pick<ContextMenuRequest, "x" | "y">,
  menu: Pick<DOMRect, "height" | "width">,
  viewport: Pick<Window, "innerHeight" | "innerWidth">,
): { readonly left: number; readonly top: number } {
  const inset = 4;
  return {
    left: Math.max(
      inset,
      Math.min(request.x, viewport.innerWidth - menu.width - inset),
    ),
    top: Math.max(
      inset,
      Math.min(request.y, viewport.innerHeight - menu.height - inset),
    ),
  };
}
