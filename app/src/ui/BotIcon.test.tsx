import { readFileSync } from "node:fs";
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { BotIcon } from "./BotIcon";

describe("BotIcon", () => {
  it("tints itself with a given colour", () => {
    render(() => <BotIcon color="var(--wl-color-online)" />);

    expect(screen.getByRole("img", { name: "bot" }).style.color).toBe(
      "var(--wl-color-online)",
    );
  });

  it("leaves its colour to the caller's stylesheet without one", () => {
    render(() => <BotIcon class="marker" data-presence="away" />);

    const icon = screen.getByRole("img", { name: "bot" });
    expect(icon).not.toHaveAttribute("style");
    expect(icon).toHaveClass("marker");
    expect(icon).toHaveAttribute("data-presence", "away");
  });

  it("centres the robot's head in its box, where the eye reads its middle", () => {
    const svg = new DOMParser().parseFromString(
      readFileSync("src/ui/bot-icon.svg", "utf8"),
      "image/svg+xml",
    );
    const [, , , boxHeight] = (
      svg.documentElement.getAttribute("viewBox") ?? ""
    )
      .split(" ")
      .map(Number);
    const head = svg.querySelector("rect");

    const top = Number(head?.getAttribute("y"));
    const height = Number(head?.getAttribute("height"));
    expect(top + height / 2).toBe((boxHeight ?? 0) / 2);
  });

  it("keeps its own role and name over a caller's", () => {
    render(() => <BotIcon aria-label="robot" role="presentation" />);

    expect(screen.getByRole("img", { name: "bot" })).toBeInTheDocument();
  });
});
