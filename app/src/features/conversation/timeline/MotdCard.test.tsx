import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { MotdCard } from "./MotdCard";
import type { MotdCardEvent } from "./motd-lines";

const motd: MotdCardEvent = {
  type: "motd",
  lines: [
    "pull up a chair.",
    "invites go through concierge: /msg concierge help",
    "",
    "be kind, ship things.",
    "history is kept for 30 days.",
    "report problems in #feedback.",
  ],
};

function renderCard(card: MotdCardEvent) {
  const [expanded, setExpanded] = createSignal(false);
  render(() => (
    <MotdCard
      card={card}
      expanded={expanded()}
      onToggle={setExpanded}
      presentation="desktop"
      timeMs={Date.UTC(2026, 10, 22, 19, 2)}
    />
  ));
}

function shownLines(): string[] {
  return Array.from(
    document.querySelectorAll("[data-motd-line]"),
    (line) => line.textContent ?? "",
  );
}

it("folds a long message of the day to four lines until shown in full", () => {
  renderCard(motd);

  const region = screen.getByRole("region", { name: /^Message of the day\./ });
  expect(region).toHaveAttribute("data-system-card", "motd");
  expect(shownLines()).toEqual([
    "pull up a chair.",
    "invites go through concierge: /msg concierge help",
    "",
    "be kind, ship things.",
  ]);

  fireEvent.click(screen.getByRole("button", { name: "Show all 6 lines" }));
  expect(shownLines()).toHaveLength(6);
  expect(shownLines().at(-1)).toBe("report problems in #feedback.");

  fireEvent.click(screen.getByRole("button", { name: "Show less" }));
  expect(shownLines()).toHaveLength(4);
});

it("shows four lines or fewer whole, with no toggle", () => {
  renderCard({ type: "motd", lines: motd.lines.slice(0, 4) });

  expect(shownLines()).toHaveLength(4);
  expect(screen.queryByRole("button")).toBeNull();
});

it("offers the toggle from the fifth line on", () => {
  renderCard({ type: "motd", lines: motd.lines.slice(0, 5) });

  expect(shownLines()).toHaveLength(4);
  expect(
    screen.getByRole("button", { name: "Show all 5 lines" }),
  ).toHaveAttribute("aria-expanded", "false");
});
