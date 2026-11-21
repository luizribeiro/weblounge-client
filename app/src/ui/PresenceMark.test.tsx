import { render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import type { PeerPresence } from "../engine/protocol";
import { PresenceMark } from "./PresenceMark";

describe("PresenceMark", () => {
  it.each(["online", "away", "offline"] as const)(
    "draws a %s person as a dot carrying that state",
    (presence) => {
      const { container } = render(() => (
        <PresenceMark bot={false} presence={presence} />
      ));

      const dot = container.querySelector("[data-presence-dot]");
      expect(dot).toHaveAttribute("data-presence", presence);
      expect(dot).toHaveAttribute("aria-hidden", "true");
      expect(container.querySelector("[data-peer-bot]")).toBeNull();
    },
  );

  it("draws nothing for a person whose presence is unknown", () => {
    const { container } = render(() => (
      <PresenceMark bot={false} presence={undefined} />
    ));

    expect(container).toBeEmptyDOMElement();
  });

  it("follows presence the network reports after it is drawn", () => {
    const [presence, setPresence] = createSignal<PeerPresence | undefined>();
    const [bot, setBot] = createSignal(false);
    const { container } = render(() => (
      <PresenceMark bot={bot()} presence={presence()} />
    ));

    setPresence("away");
    expect(container.querySelector("[data-presence-dot]")).toHaveAttribute(
      "data-presence",
      "away",
    );
    setBot(true);
    expect(container.querySelector("[data-peer-bot]")).toHaveAttribute(
      "data-presence",
      "away",
    );
    expect(container.querySelector("[data-presence-dot]")).toBeNull();
  });

  it.each(["online", "away", "offline"] as const)(
    "draws a %s bot as the robot wearing a badge of that state",
    (presence) => {
      const { container } = render(() => (
        <PresenceMark bot presence={presence} />
      ));

      const bot = container.querySelector("[data-peer-bot]");
      expect(bot).toHaveAttribute("data-presence", presence);
      expect(bot).toContainElement(screen.getByRole("img", { name: "bot" }));
      expect(bot?.querySelector("[aria-hidden='true']")).not.toBeNull();
      expect(container.querySelectorAll("[data-presence]")).toHaveLength(1);
    },
  );

  it("draws a bot whose presence is unknown as a plain robot", () => {
    const { container } = render(() => (
      <PresenceMark bot presence={undefined} />
    ));

    const bot = container.querySelector("[data-peer-bot]");
    expect(bot).not.toHaveAttribute("data-presence");
    expect(bot?.querySelector("[aria-hidden='true']")).toBeNull();
  });
});
