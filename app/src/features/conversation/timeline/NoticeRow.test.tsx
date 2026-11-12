import { render, screen } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import type { MessageProjection } from "../../../engine/protocol";
import { NoticeRow } from "./NoticeRow";
import type { IrcNoticeMessage } from "./notice-message";

const base: MessageProjection = {
  id: 1,
  author: "NickServ",
  text: "You are now identified",
  kind: { irc_notice: "service" },
  bot: null,
  authorship: "other",
  nick_color_index: 2,
  highlighted: false,
  delivery: "received",
  local_send_id: null,
  server_ids: [],
  server_time_ms: 1_700_000_000_000,
  received_at_ms: 1_700_000_000_100,
  reactions: [],
  unverified_sender: false,
};

function notice(source: "user" | "service" | "server"): IrcNoticeMessage {
  return { ...base, kind: { irc_notice: source } };
}

it("renders a desktop service notice with notice chrome", () => {
  render(() => (
    <NoticeRow
      message={notice("service")}
      nickLookup={new Map()}
      presentation="desktop"
    />
  ));

  const row = screen.getByText(base.text).closest("[data-message-row]");
  expect(row).toHaveAttribute("data-notice-source", "service");
  expect(screen.getByRole("img", { name: "Notice" })).toBeVisible();
  expect(screen.getByText("NickServ")).toBeVisible();
  expect(row?.querySelector("time")).toHaveAttribute(
    "datetime",
    new Date(base.server_time_ms ?? 0).toISOString(),
  );
});

it("renders a phone server notice as one flowing line", () => {
  render(() => (
    <NoticeRow
      message={{ ...notice("server"), author: "zinc.libera.chat" }}
      nickLookup={new Map()}
      presentation="mobile"
    />
  ));

  const row = screen.getByText(base.text).closest("[data-message-row]");
  expect(row).toHaveAttribute("data-presentation", "mobile");
  expect(screen.getByRole("img", { name: "Server notice" })).toBeVisible();
  expect(row).toHaveTextContent("zinc.libera.chat");
  expect(row?.querySelector("[data-selectable]")).toContainElement(
    row?.querySelector("time") ?? null,
  );
});
