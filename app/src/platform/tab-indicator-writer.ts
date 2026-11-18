import faviconVariants from "../../assets/favicon-variants.json" with {
  type: "json",
};
import type { TabIcon, TabIndicator } from "../features/unread/tab-indicator";

const iconFiles: Readonly<
  Record<TabIcon, { readonly svg: string; readonly png: string }>
> = faviconVariants;

export function tabIconHref(type: string, icon: TabIcon): string | undefined {
  const files = iconFiles[icon];
  if (type === "image/svg+xml") return `/icons/${files.svg}`;
  if (type === "image/png") return `/icons/${files.png}`;
  return undefined;
}

/** Writes the tab's icon links and title, touching the DOM only on change. */
export function createTabIndicatorWriter(
  document: Document,
): (indicator: TabIndicator) => void {
  let shown: TabIndicator = { icon: "connected", title: document.title };
  return (next) => {
    if (next.icon !== shown.icon) {
      for (const link of document.querySelectorAll<HTMLLinkElement>(
        'link[rel="icon"]',
      )) {
        const href = tabIconHref(link.type, next.icon);
        if (href === undefined) continue;
        link.setAttribute("href", href);
        link.dataset.tabIcon = next.icon;
      }
    }
    if (next.title !== shown.title) document.title = next.title;
    shown = next;
  };
}
