import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { ReactionChips } from "./ReactionChips";

it("renders counts, ownership, text truncation, and the full who tooltip", async () => {
  render(() => (
    <ReactionChips
      reactions={[
        {
          text: "👍",
          actors: [
            { nick: "alice", mine: false },
            { nick: "weblounge", mine: true },
          ],
          mine: true,
        },
        {
          text: "ship it, ship it now",
          actors: [{ nick: "alice", mine: false }],
          mine: false,
        },
      ]}
    />
  ));

  const own = screen.getByLabelText("👍, 2 reactions, including you");
  expect(own).toHaveAttribute("data-reaction-own", "true");
  expect(own).toHaveTextContent("👍2");
  expect(
    screen.getByLabelText("ship it, ship it now, 1 reaction"),
  ).toHaveTextContent("ship it, ship it…1");

  fireEvent.mouseEnter(own);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "alice and you reacted with 👍",
  );
});
