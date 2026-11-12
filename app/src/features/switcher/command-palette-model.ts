import type { ActionEntry, ActionId } from "../../actions/action-registry";
import { fuzzyScore } from "./buffer-switcher-model";

export type OmnibarMode = "buffers" | "commands";

export function omnibarMode(query: string): OmnibarMode {
  return query.startsWith(">") ? "commands" : "buffers";
}

export function commandQuery(query: string): string {
  return omnibarMode(query) === "commands" ? query.slice(1).trim() : "";
}

export function paletteActions(
  actions: readonly ActionEntry[],
  recentActionIds: readonly ActionId[],
  query: string,
): readonly ActionEntry[] {
  const needle = query.toLocaleLowerCase();
  const recency = new Map(recentActionIds.map((id, index) => [id, index]));
  return actions
    .map((action) => ({
      action,
      score: fuzzyScore(
        `${action.title} ${action.group ?? ""}`.toLocaleLowerCase(),
        needle,
      ),
    }))
    .filter(
      (candidate): candidate is typeof candidate & { readonly score: number } =>
        candidate.score !== undefined,
    )
    .sort((first, second) => {
      const firstRecent = recency.get(first.action.id);
      const secondRecent = recency.get(second.action.id);
      const rank = (score: number, recent: number | undefined) =>
        score + Math.min(recent ?? 4, 4) * 2;
      const rankDifference =
        rank(first.score, firstRecent) - rank(second.score, secondRecent);
      if (rankDifference !== 0) return rankDifference;
      if (first.score !== second.score) return first.score - second.score;
      if (firstRecent !== undefined || secondRecent !== undefined)
        return (
          (firstRecent ?? Number.MAX_SAFE_INTEGER) -
          (secondRecent ?? Number.MAX_SAFE_INTEGER)
        );
      return first.action.title.localeCompare(second.action.title);
    })
    .map(({ action }) => action);
}
