import { render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import type { TypingProjection } from "../../engine/protocol";
import { TypingIndicator } from "./TypingIndicator";

const typer = (nick: string, nickColorIndex: number): TypingProjection => ({
  nick,
  nick_color_index: nickColorIndex,
  paused: false,
});

it("announces bounded typing wording with nick colours", () => {
  const [typers, setTypers] = createSignal<TypingProjection[]>([]);
  render(() => <TypingIndicator typers={typers()} />);
  const indicator = screen.getByText("", {
    selector: "[data-typing-indicator]",
  });
  expect(indicator).toHaveAttribute("aria-live", "polite");
  expect(indicator).toHaveAttribute("aria-atomic", "true");

  setTypers([typer("ana", 2)]);
  expect(indicator).toHaveTextContent("ana is typing…");
  expect(indicator.querySelector("[data-typing-nick='ana']")).toHaveStyle({
    color: "var(--wl-nick-2)",
  });

  setTypers([typer("ana", 2), typer("bob", 3)]);
  expect(indicator).toHaveTextContent("ana and bob are typing…");

  setTypers([typer("ana", 2), typer("bob", 3), typer("mel", 4)]);
  expect(indicator).toHaveTextContent("several people are typing…");
  expect(indicator.querySelectorAll("[data-typing-nick]")).toHaveLength(0);
});
