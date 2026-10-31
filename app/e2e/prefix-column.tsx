import { render } from "solid-js/web";
import { installDensity } from "../src/density/density";
import type { BufferProjection, EngineToUi } from "../src/engine/protocol";
import {
  MemberPanel,
  type MemberWindow,
} from "../src/features/members/MemberPanel";
import sidebarStyles from "../src/features/sidebar/Sidebar.module.css";
import { SidebarRow } from "../src/features/sidebar/SidebarRow";
import { installPlatformEnvironment } from "../src/platform/environment";
import "../src/styles/base.css";
import { installTheme } from "../src/theme/theme-controller";

type Member = Extract<
  EngineToUi,
  { type: "members_changed" }
>["members"][number];

const root = document.getElementById("root");
if (root === null) throw new Error("missing prefix-column harness root");
installDensity(document);
const platform = installPlatformEnvironment(root, window);
installTheme(document, platform.prefersDark());

function Harness() {
  return (
    <main style={{ display: "flex", gap: "24px", height: "600px" }}>
      <aside
        aria-label="Channel samples"
        style={{ width: "256px", padding: "8px" }}
      >
        <div class={sidebarStyles.rows}>
          <SidebarRow
            active={false}
            buffer={buffer(1, "channel", "#lounge")}
            onClick={() => {}}
            tabIndex={-1}
          />
          <SidebarRow
            active={false}
            buffer={buffer(2, "channel", "&help")}
            onClick={() => {}}
            tabIndex={-1}
          />
          <SidebarRow
            active={false}
            buffer={buffer(3, "direct", "mel")}
            onClick={() => {}}
            tabIndex={-1}
          />
        </div>
      </aside>
      <MemberPanel
        bufferTitle="#lounge"
        onClose={() => {}}
        onOpenDirect={() => {}}
        onRequestRange={() => {}}
        window={memberWindow}
      />
    </main>
  );
}

function buffer(
  id: number,
  kind: BufferProjection["kind"],
  title: string,
): BufferProjection {
  return {
    id,
    network_id: 1,
    kind,
    title,
    draft_key: title,
    topic: null,
    unread: 0,
    mentions: 0,
    read_through: null,
  };
}

const members: readonly Member[] = [
  { ...member("operators", "owner", "@"), is_you: true },
  member("operators", "founder", "~"),
  { ...member("operators", "admin", "&"), bot: true },
  member("operators", "halfop", "%"),
  member("voiced", "voice", "+"),
  member("online", "plain", null),
];

const memberWindow: MemberWindow = {
  type: "members_changed",
  buffer_id: 1,
  view_id: "prefix-column:desktop:pane-1",
  version: 0,
  window_size: 256,
  offset: 0,
  total: members.length,
  counts: [4, 1, 1, 0, 0],
  members: [...members],
};

function member(
  group: Member["group"],
  nick: string,
  modeSymbol: string | null,
): Member {
  return {
    group,
    nick,
    mode_symbol: modeSymbol,
    away: false,
    bot: false,
    account: null,
    nick_color_index: 0,
    is_you: false,
  };
}

render(() => <Harness />, root);
