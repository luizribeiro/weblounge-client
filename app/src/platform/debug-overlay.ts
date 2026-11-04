import "./viewport-debug.css";
import { buildVersion } from "../build-version";
import { deploymentConfigUnknownFields } from "../hosted/deployment-config";

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
const engineReadings = new WeakMap<Window, Map<string, string>>();
const notificationReadings = new WeakMap<Window, string>();
const pushSnapshots = new WeakMap<Window, PushDebugSnapshot>();

export interface PushDebugSnapshot {
  readonly summary: string;
  readonly readings: readonly DebugReading[];
}

export function setEngineDebugReading(
  browserWindow: Window,
  key: string,
  reading: string | undefined,
): void {
  const readings = engineReadings.get(browserWindow) ?? new Map();
  if (reading === undefined) readings.delete(key);
  else readings.set(key, reading);
  if (readings.size === 0) engineReadings.delete(browserWindow);
  else engineReadings.set(browserWindow, readings);
  managers.get(browserWindow)?.render();
}

export function setNotificationDebugReading(
  browserWindow: Window,
  reading: string | undefined,
): void {
  if (reading === undefined) notificationReadings.delete(browserWindow);
  else notificationReadings.set(browserWindow, reading);
  managers.get(browserWindow)?.render();
}

export function setPushDebugSnapshot(
  browserWindow: Window,
  snapshot: PushDebugSnapshot | undefined,
): void {
  if (snapshot === undefined) pushSnapshots.delete(browserWindow);
  else pushSnapshots.set(browserWindow, snapshot);
  managers.get(browserWindow)?.render();
}

export function installPushDebug(
  _root: HTMLElement,
  browserWindow: Window,
): () => void {
  return installDebugSection(browserWindow, {
    id: "push",
    title: "push",
    read: () =>
      pushSnapshots.get(browserWindow)?.readings ?? [["status", "unavailable"]],
  });
}

export function installDefaultDebug(
  _root: HTMLElement,
  browserWindow: Window,
): () => void {
  return installDebugSection(browserWindow, {
    id: "default",
    title: "debug",
    read: () => [],
  });
}

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
          [
            `[${section.title}]`,
            buildVersion.text,
            `config unknown: ${deploymentConfigUnknownFields().join(", ") || "none"}`,
            `engine: ${formatEngineReadings(engineReadings.get(browserWindow))}`,
            `notifications: ${notificationReadings.get(browserWindow) ?? "unavailable"}`,
            `push: ${pushSnapshots.get(browserWindow)?.summary ?? "unavailable"}`,
            ...format(section.read()),
          ].join("\n"),
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

function formatEngineReadings(
  readings: Map<string, string> | undefined,
): string {
  return readings === undefined ? "none" : [...readings.values()].join(" / ");
}
