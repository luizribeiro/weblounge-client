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

  it("keeps its own role and name over a caller's", () => {
    render(() => <BotIcon aria-label="robot" role="presentation" />);

    expect(screen.getByRole("img", { name: "bot" })).toBeInTheDocument();
  });
});
