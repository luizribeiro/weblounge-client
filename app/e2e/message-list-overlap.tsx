import { batch, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { installDensity } from "../src/density/density";
import type { MessageProjection } from "../src/engine/protocol";
import { MessageList } from "../src/features/conversation/MessageList";
import {
  currentMessageDensity,
  estimateMessageHeight,
} from "../src/features/conversation/message-size-estimate";
import { installPlatformEnvironment } from "../src/platform/environment";
import "../src/styles/base.css";
import { installTheme } from "../src/theme/theme-controller";
import { harnessHistoryLength } from "./timeline-fixtures";

export interface MessageListOverlapHarness {
  readonly append: (texts: readonly string[], readThrough: number) => void;
  readonly estimate: (text: string, width: number) => number;
  readonly markRead: (readThrough: number) => void;
}

declare global {
  interface Window {
    messageListOverlap?: MessageListOverlapHarness;
  }
}

const desktopSidebarWidth = 256;
const start = new Date(2026, 9, 30, 14).getTime();

function harnessMessage(id: number, text: string): MessageProjection {
  return {
    id,
    author: id % 2 === 0 ? "amartinez" : "checksumbyte",
    text,
    kind: "text",
    bot: false,
    mode_symbol: null,
    authorship: "other",
    nick_color_index: id * 7_919,
    mentioned: false,
    delivery: "received",
    local_send_id: null,
    server_ids: [`overlap-${id}`],
    server_time_ms: start + id * 60_000,
    received_at_ms: start + id * 60_000,
  };
}

const history = Array.from({ length: harnessHistoryLength }, (_, index) =>
  harnessMessage(index + 1, `earlier message ${index + 1}`),
);

installDensity(document);
const root = document.getElementById("root");
if (root === null) throw new Error("missing overlap harness root");
const platform = installPlatformEnvironment(root, window);
installTheme(document, platform.prefersDark());

const [messages, setMessages] =
  createSignal<readonly MessageProjection[]>(history);
const [readThrough, setReadThrough] = createSignal(history.length);
const [atLiveEdge, setAtLiveEdge] = createSignal(true);

window.messageListOverlap = {
  append: (texts, nextReadThrough) =>
    batch(() => {
      setMessages((current) => [
        ...current,
        ...texts.map((text, index) =>
          harnessMessage(current.length + index + 1, text),
        ),
      ]);
      setReadThrough(nextReadThrough);
    }),
  estimate: (text, width) =>
    estimateMessageHeight(
      { kind: "text", text },
      width,
      currentMessageDensity(document.documentElement),
    ),
  markRead: setReadThrough,
};

render(
  () => (
    <div
      data-live-edge={atLiveEdge()}
      data-overlap-harness="ready"
      style={{
        display: "grid",
        "grid-template-columns": `${desktopSidebarWidth}px minmax(0, 1fr)`,
        "grid-template-rows": "minmax(0, 1fr)",
        height: "100vh",
      }}
    >
      <aside />
      <MessageList
        messages={messages()}
        onLiveEdgeChange={setAtLiveEdge}
        readThrough={readThrough()}
      />
    </div>
  ),
  root,
);
