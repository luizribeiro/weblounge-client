import presetData from "../../densities/presets.json";

export type DensityId = "compact" | "cozy" | "comfortable";
export type MessageLayout = "oneLine" | "grouped";

export interface DensitySettings {
  readonly messageLayout: MessageLayout;
  readonly message: DensityId;
  readonly desktopList: DensityId;
  readonly mobileList: DensityId;
}

export interface DensityPreset {
  readonly messageAvatar: string;
  readonly groupTopPadding: string;
  readonly continuationPadding: string;
  readonly oneLineRowPadding: string;
  readonly lineHeight: string;
  readonly fontDelta: string;
  readonly sidebarRowHeight: string;
  readonly sidebarFontSize: string;
  readonly memberRowHeight: string;
  readonly memberAvatar: string;
  readonly mobileRowHeight: string;
  readonly mobileAvatar: string;
  readonly mobilePreviews: boolean;
}

export const densityDefaults: DensitySettings = {
  messageLayout: "oneLine",
  message: "cozy",
  desktopList: "compact",
  mobileList: "cozy",
};

export const densityPresets = validatePresets(presetData);

export function densityStyleSheet(): string {
  return (Object.entries(densityPresets) as [DensityId, DensityPreset][])
    .flatMap(([id, preset]) => [
      densityRule("message-density", "message", id, {
        avatar: preset.messageAvatar,
        continuationPadding: preset.continuationPadding,
        fontDelta: preset.fontDelta,
        groupTopPadding: preset.groupTopPadding,
        lineHeight: preset.lineHeight,
        oneLineRowPadding: preset.oneLineRowPadding,
      }),
      densityRule("sidebar-density", "sidebar", id, {
        avatar: preset.memberAvatar,
        fontSize: preset.sidebarFontSize,
        memberRowHeight: preset.memberRowHeight,
        rowHeight: preset.sidebarRowHeight,
      }),
      densityRule("mobile-density", "mobile", id, {
        avatar: preset.mobileAvatar,
        rowHeight: preset.mobileRowHeight,
      }),
    ])
    .join("");
}

export function installDensity(
  document: Document,
  settings: DensitySettings = densityDefaults,
): () => void {
  const root = document.documentElement;
  root.dataset.messageLayout = settings.messageLayout;
  root.dataset.messageDensity = settings.message;
  root.dataset.sidebarDensity = settings.desktopList;
  root.dataset.mobileDensity = settings.mobileList;
  return () => {};
}

function validatePresets(
  value: unknown,
): Readonly<Record<DensityId, DensityPreset>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("density presets must be an object");
  }
  const expected = ["comfortable", "compact", "cozy"];
  if (Object.keys(value).sort().join("\0") !== expected.join("\0")) {
    throw new Error(
      "density presets must define compact, cozy, and comfortable",
    );
  }
  return value as Readonly<Record<DensityId, DensityPreset>>;
}

function densityRule(
  attribute: string,
  group: string,
  id: DensityId,
  values: Readonly<Record<string, string>>,
): string {
  const properties = Object.entries(values)
    .map(
      ([token, value]) =>
        `--wl-density-${group}-${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value}`,
    )
    .join(";");
  return `:root[data-${attribute}="${id}"]{${properties}}`;
}
