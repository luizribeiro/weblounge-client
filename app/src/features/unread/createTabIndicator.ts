import { type Accessor, createEffect } from "solid-js";
import { connectionIndicatorShown } from "../../engine/connection-state";
import type { Settings } from "../../engine/generated/Settings";
import type {
  BufferProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { platformEnvironment } from "../../platform/environment";
import { appBadgeCount } from "../../platform/push/app-badge";
import { createTabIndicatorWriter } from "../../platform/tab-indicator-writer";
import { tabIndicator } from "./tab-indicator";

interface TabIndicatorSources {
  readonly buffers: Accessor<readonly BufferProjection[]>;
  readonly networks: Accessor<readonly NetworkProjection[]>;
  readonly settings: Accessor<Settings | undefined>;
}

/** Mirrors unread and connection state into a browser tab's icon and title. */
export function createTabIndicator(sources: TabIndicatorSources): void {
  const platform = platformEnvironment();
  const baseTitle = document.title;
  const write = createTabIndicatorWriter(document);
  createEffect(() => {
    if (platform.environment().display !== "browser") return;
    write(
      tabIndicator({
        baseTitle,
        disconnected: connectionIndicatorShown(sources.networks()),
        // Until the engine answers, a user who turned this off must not see a red flash.
        showUnread: sources.settings()?.app.unread_tab_indicator ?? false,
        unreadCount: appBadgeCount(sources.buffers()),
      }),
    );
  });
}
