import type { TabIcon, TabIndicator } from "../features/unread/tab-indicator";

// scripts/generate-icons.mjs writes one SVG and one PNG favicon per suffix.
const iconSuffixes: Readonly<Record<TabIcon, string>> = {
  connected: "",
  unread: "-unread",
  disconnected: "-disconnected",
};

function tabIconHref(type: string, icon: TabIcon): string | undefined {
  const suffix = iconSuffixes[icon];
  if (type === "image/svg+xml") return `/icons/favicon${suffix}.svg`;
  if (type === "image/png") return `/icons/favicon-32${suffix}.png`;
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
        if (href !== undefined) link.setAttribute("href", href);
      }
    }
    if (next.title !== shown.title) document.title = next.title;
    shown = next;
  };
}
