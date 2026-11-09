import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { type Member, MemberRow } from "./MemberRow";

const member: Member = {
  group: "operators",
  nick: "concierge",
  mode_symbol: "@",
  away: false,
  bot: true,
  account: { state: "logged_in", name: "concierge" },
  nick_color_index: 8,
  is_you: false,
};

it("renders member facts and opens the direct conversation", () => {
  const open = vi.fn();
  render(() => <MemberRow member={member} onOpenDirect={open} />);

  expect(screen.getByText("@")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "bot" })).toHaveStyle({
    color: "var(--wl-nick-2)",
  });
  expect(screen.queryByText("BOT")).not.toBeInTheDocument();
  expect(screen.getByText("concierge")).toHaveStyle({
    color: "var(--wl-nick-2)",
  });
  expect(screen.getByText("@")).toHaveAttribute("data-member-prefix", "true");
  expect(screen.getByText("concierge")).toHaveAttribute(
    "data-member-name",
    "true",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Open direct message with concierge" }),
  );
  expect(open).toHaveBeenCalledWith("concierge");
});

it("dims away members and can hide mode symbols", () => {
  const { container } = render(() => (
    <MemberRow
      member={{ ...member, away: true, bot: false, is_you: true }}
      onOpenDirect={() => {}}
      showModeSymbol={false}
    />
  ));
  expect(container.querySelector("[data-away='true']")).not.toBeNull();
  expect(screen.queryByText("@")).not.toBeInTheDocument();
  expect(screen.getByText("you")).toBeInTheDocument();
});

it("keeps unknown identity facts distinct from proven negatives", () => {
  const { container } = render(() => (
    <MemberRow
      member={{ ...member, account: { state: "unknown" }, bot: null }}
      onOpenDirect={() => {}}
    />
  ));
  const row = container.querySelector("[data-account-state='unknown']");
  expect(row).toHaveAttribute("data-bot-known", "false");
  expect(screen.queryByText("BOT")).not.toBeInTheDocument();
});
