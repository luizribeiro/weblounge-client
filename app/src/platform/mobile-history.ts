export type MobileHistoryPolicy = "replace" | "stack";

interface MobilePlatformFeatures {
  readonly displayModeStandalone: boolean;
  readonly navigatorStandalone: boolean;
  readonly coarsePointer: boolean;
  readonly webkitPoint: boolean;
}

export function mobileHistoryPolicy(
  features: MobilePlatformFeatures = browserFeatures(),
): MobileHistoryPolicy {
  return features.coarsePointer && features.webkitPoint ? "replace" : "stack";
}

function browserFeatures(): MobilePlatformFeatures {
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  return {
    displayModeStandalone: window.matchMedia("(display-mode: standalone)")
      .matches,
    navigatorStandalone: iosNavigator.standalone === true,
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
    webkitPoint: "WebKitPoint" in window,
  };
}
