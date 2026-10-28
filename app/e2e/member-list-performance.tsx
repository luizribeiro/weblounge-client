import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { installDensity } from "../src/density/density";
import type { EngineToUi } from "../src/engine/protocol";
import {
  MemberPanel,
  type MemberWindow,
} from "../src/features/members/MemberPanel";
import "../src/styles/base.css";
import { installSystemTheme } from "../src/theme/theme-controller";

type Member = Extract<
  EngineToUi,
  { type: "members_changed" }
>["members"][number];
const groups = ["operators", "voiced", "online", "away", "bots"] as const;
const counts = [500, 500, 7_000, 1_000, 1_000] as const;
const members: Member[] = groups.flatMap((group, groupIndex) =>
  Array.from({ length: counts[groupIndex] }, (_, index) => ({
    group,
    nick: `${group}-${index.toString().padStart(4, "0")}`,
    mode_symbol: group === "operators" ? "@" : group === "voiced" ? "+" : null,
    away: group === "away",
    bot: group === "bots",
    account: null,
    nick_color_index: index,
    is_you: groupIndex === 2 && index === 0,
  })),
);

installDensity(document);
installSystemTheme(document, window);
const root = document.getElementById("root");
if (root === null) throw new Error("missing performance harness root");
root.style.height = "100%";
render(() => <Harness />, root);

function Harness() {
  const windowAt = (offset: number): MemberWindow => ({
    type: "members_changed",
    buffer_id: 1,
    offset,
    total: members.length,
    counts: [...counts],
    members: members.slice(offset, offset + 256),
  });
  const [memberWindow, setMemberWindow] = createSignal(windowAt(0));
  return (
    <div
      data-performance-harness="members"
      style={{ display: "flex", height: "100%", width: "232px" }}
    >
      <MemberPanel
        bufferTitle="#ten-thousand"
        onClose={() => {}}
        onOpenDirect={() => {}}
        onRequestRange={(offset) => setMemberWindow(windowAt(offset))}
        window={memberWindow()}
      />
    </div>
  );
}
