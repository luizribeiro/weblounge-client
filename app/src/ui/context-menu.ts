export type ContextSurfaceKind = "chrome" | "selectable";

export interface ContextMenuRequest {
  readonly invoker: HTMLElement;
  readonly x: number;
  readonly y: number;
}

export interface ContextSurface {
  readonly id: string;
  readonly kind: ContextSurfaceKind;
  readonly commandContext?: {
    readonly scope: string;
    readonly targetId?: string;
  };
  readonly openMenu?: (request: ContextMenuRequest) => void;
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
    const match = this.#resolve(event.composedPath());
    if (match?.surface.kind === "selectable") return;
    event.preventDefault();
    if (match?.surface.openMenu !== undefined) {
      match.surface.openMenu({
        invoker: match.element,
        x: event.clientX,
        y: event.clientY,
      });
    }
  }

  handleKeydown(event: KeyboardEvent): void {
    if (!isMenuKey(event)) return;
    const match = this.#resolve(event.composedPath());
    if (match?.surface.openMenu === undefined) return;
    const bounds = match.element.getBoundingClientRect();
    event.preventDefault();
    event.stopPropagation();
    match.surface.openMenu({
      invoker: match.element,
      x: bounds.left + 8,
      y: bounds.bottom,
    });
  }

  #resolve(
    path: readonly EventTarget[],
  ):
    | { readonly element: HTMLElement; readonly surface: ContextSurface }
    | undefined {
    for (const target of path) {
      if (target instanceof HTMLElement) {
        const surface = this.#surfaces.get(target);
        if (surface !== undefined) return { element: target, surface };
      }
    }
    return undefined;
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
  const handleKeydown: EventListener = (event) => {
    if (event instanceof KeyboardEvent) registry.handleKeydown(event);
  };
  target.addEventListener("contextmenu", handle);
  target.addEventListener("keydown", handleKeydown);
  return () => {
    target.removeEventListener("contextmenu", handle);
    target.removeEventListener("keydown", handleKeydown);
  };
}

function isMenuKey(event: KeyboardEvent): boolean {
  return (
    event.key === "ContextMenu" ||
    (event.key === "F10" &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey)
  );
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
