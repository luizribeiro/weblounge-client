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
    expect(screen.getByRole("img", { name: "bot" })).toHaveAttribute(
      "data-presence",
      "away",
    );
    expect(container.querySelector("[data-presence-dot]")).toBeNull();
  });

  it.each(["online", "away", "offline"] as const)(
    "draws a %s bot as the robot instead of a dot",
    (presence) => {
      const { container } = render(() => (
        <PresenceMark bot presence={presence} />
      ));

      const robot = screen.getByRole("img", { name: "bot" });
      expect(robot).toHaveAttribute("data-peer-bot", "true");
      expect(robot).toHaveAttribute("data-presence", presence);
      expect(container.querySelector("[data-presence-dot]")).toBeNull();
    },
  );

  it("draws a bot whose presence is unknown as a robot with no state", () => {
    render(() => <PresenceMark bot presence={undefined} />);

    expect(screen.getByRole("img", { name: "bot" })).not.toHaveAttribute(
      "data-presence",
    );
  });
});
