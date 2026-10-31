import "./viewport-debug.css";

export type DebugReading = readonly [label: string, value: string];

export interface DebugSection {
  readonly id: string;
  readonly title: string;
  readonly read: () => readonly DebugReading[];
  readonly subscribe?: ((render: () => void) => () => void) | undefined;
}

interface ActiveSection {
  readonly section: DebugSection;
  readonly stop: () => void;
}

interface OverlayManager {
  readonly overlay: HTMLPreElement;
  readonly sections: Map<string, ActiveSection>;
  render(): void;
}

const managers = new WeakMap<Window, OverlayManager>();

export function installDebugSection(
  browserWindow: Window,
  section: DebugSection,
): () => void {
  const manager = managerFor(browserWindow);
  manager.sections.get(section.id)?.stop();
  const active = {
    section,
    stop: section.subscribe?.(() => manager.render()) ?? (() => {}),
  };
  manager.sections.set(section.id, active);
  manager.render();
  return () => {
    if (manager.sections.get(section.id) !== active) return;
    active.stop();
    manager.sections.delete(section.id);
    if (manager.sections.size === 0) {
      manager.overlay.remove();
      managers.delete(browserWindow);
    } else manager.render();
  };
}

function managerFor(browserWindow: Window): OverlayManager {
  const existing = managers.get(browserWindow);
  if (existing !== undefined) return existing;
  const overlay = browserWindow.document.createElement("pre");
  overlay.dataset.debugOverlay = "true";
  overlay.setAttribute("aria-hidden", "true");
  browserWindow.document.body.append(overlay);
  const manager: OverlayManager = {
    overlay,
    sections: new Map(),
    render() {
      overlay.textContent = [...manager.sections.values()]
        .map(({ section }) =>
          [`[${section.title}]`, ...format(section.read())].join("\n"),
        )
        .join("\n\n");
    },
  };
  managers.set(browserWindow, manager);
  return manager;
}

function format(readings: readonly DebugReading[]): readonly string[] {
  return readings.map(([label, value]) => `${label}: ${value}`);
}
