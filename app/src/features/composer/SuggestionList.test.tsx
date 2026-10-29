import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { SuggestionList } from "./SuggestionList";

it("renders rich options and routes pointer selection", () => {
  const accept = vi.fn();
  const select = vi.fn();
  render(() => (
    <SuggestionList
      candidates={[
        {
          type: "command",
          name: "join",
          usage: "cmd.join.usage",
          description: "cmd.join.description",
        },
        {
          type: "person",
          nick: "ana",
          nick_color_index: 2,
          away: true,
          bot: true,
        },
        {
          type: "person",
          nick: "mel",
          nick_color_index: 3,
          away: false,
          bot: false,
        },
        { type: "channel", name: "#papo" },
      ]}
      completionInput="/"
      hint="cmd.join.usage"
      listId="suggestions"
      onAccept={accept}
      onSelect={select}
      optionId={(index) => `suggestion-${index}`}
      selected={1}
    />
  ));

  expect(screen.getByRole("listbox")).toHaveAttribute("id", "suggestions");
  expect(screen.getByRole("listbox").parentElement).toHaveAttribute(
    "data-completion-input",
    "/",
  );
  expect(screen.getAllByRole("option")).toHaveLength(4);
  expect(
    screen.getByText("<channels> [keys] · Join one or more channels"),
  ).toBeVisible();
  expect(screen.queryByText(/\/join \/join/u)).not.toBeInTheDocument();
  expect(screen.queryByText("Member")).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: /ana/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByText("BOT")).toBeVisible();
  fireEvent.mouseEnter(screen.getByRole("option", { name: /#papo/u }));
  fireEvent.click(screen.getByRole("option", { name: /#papo/u }));
  expect(select).toHaveBeenCalledWith(3);
  expect(accept).toHaveBeenCalledWith(3);
});
