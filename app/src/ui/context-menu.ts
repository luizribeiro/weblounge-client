export type ContextSurfaceKind = "chrome" | "selectable";

export interface ContextSurface {
  readonly id: string;
  readonly kind: ContextSurfaceKind;
  readonly commandContext?: {
    readonly scope: string;
    readonly targetId?: string;
  };
}

export class ContextMenuRegistry {
  readonly #surfaces = new WeakMap<Element, ContextSurface>();

  register(element: Element, surface: ContextSurface): () => void {
    this.#surfaces.set(element, surface);
    return () => {
      if (this.#surfaces.get(element) === surface) {
        this.#surfaces.delete(element);
      }
    };
  }

  resolve(path: readonly EventTarget[]): ContextSurface | undefined {
    for (const target of path) {
      if (target instanceof Element) {
        const surface = this.#surfaces.get(target);
        if (surface !== undefined) return surface;
      }
    }
    return undefined;
  }

  handle(event: MouseEvent): void {
    if (isEditablePath(event.composedPath())) return;
    if (this.resolve(event.composedPath())?.kind === "selectable") return;
    event.preventDefault();
  }
}

export const contextMenuRegistry = new ContextMenuRegistry();

export function installContextMenuHandler(
  target: Document | HTMLElement,
  registry: ContextMenuRegistry = contextMenuRegistry,
): () => void {
  const handle: EventListener = (event) => {
    if (event instanceof MouseEvent) registry.handle(event);
  };
  target.addEventListener("contextmenu", handle);
  return () => target.removeEventListener("contextmenu", handle);
}

function isEditablePath(path: readonly EventTarget[]): boolean {
  return path.some(
    (target) =>
      target instanceof Element &&
      target.matches(
        "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
      ),
  );
}
