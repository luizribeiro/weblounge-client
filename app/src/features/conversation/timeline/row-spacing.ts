export type RowFamily = "divider" | "line" | "message";
export type RowSpacing = "after-divider" | "after-line" | "after-message";

export function topPadding(
  previous: RowFamily | undefined,
  row: RowFamily,
  _presentation: "desktop" | "mobile",
): RowSpacing {
  if (row !== "line")
    return previous === "divider" ? "after-divider" : "after-message";
  if (previous === "divider") return "after-divider";
  return previous === undefined || previous === "line"
    ? "after-line"
    : "after-message";
}
