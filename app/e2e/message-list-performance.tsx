import { render } from "solid-js/web";
import { installDensity } from "../src/density/density";
import type { MessageProjection } from "../src/engine/protocol";
import { MessageList } from "../src/features/conversation/MessageList";
import { installPlatformEnvironment } from "../src/platform/environment";
import "../src/styles/base.css";
import { installTheme } from "../src/theme/theme-controller";

const authors = [
  { authorship: "other", color: 338_283_141, nick: "ana" },
  { authorship: "other", color: 3_892_367_689, nick: "luiz" },
  { authorship: "other", color: 4_290_226_655, nick: "bruno" },
  { authorship: "other", color: 107_009_103, nick: "cyd" },
  { authorship: "other", color: 846_122_444, nick: "tomo" },
  { authorship: "other", color: 3_417_136_529, nick: "mel" },
  { authorship: "other", color: 2_528_155_197, nick: "rafa" },
  { authorship: "own", color: 626_957_379, nick: "weblounge" },
] as const;
const now = new Date(2026, 9, 28, 12).getTime();
const messages = Array.from({ length: 10_000 }, (_, index) => {
  const author = authors[index % authors.length] ?? authors[0];
  return {
    id: index + 1,
    author: author.nick,
    text:
      index % 97 === 0
        ? "weblounge: how should IRC history behave here?"
        : `message ${index + 1} about IRC history and the open web`,
    kind: index % 113 === 0 ? "action" : "text",
    bot: author.nick === "tomo",
    mode_symbol: author.nick === "luiz" ? "@" : null,
    authorship: author.authorship,
    nick_color_index: author.color,
    highlighted: author.authorship === "other" && index % 97 === 0,
    delivery: "received",
    local_send_id: null,
    server_ids: [`render-only-${index + 1}`],
    server_time_ms: now - (10_000 - index) * 60_000,
    received_at_ms: now - (10_000 - index) * 60_000,
  } satisfies MessageProjection;
});

installDensity(document);
const root = document.getElementById("root");
if (root === null) throw new Error("missing performance harness root");
const platform = installPlatformEnvironment(root, window);
installTheme(document, platform.prefersDark());
root.style.height = "100%";
render(
  () => (
    <div data-performance-harness="render-only" style={{ height: "100%" }}>
      <MessageList messages={messages} />
    </div>
  ),
  root,
);
