import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { DirectPresence } from "./DirectPresence";

describe("DirectPresence", () => {
  it.each(["online", "away", "offline"] as const)(
    "names a person's %s state after the conversation kind, with its dot",
    (presence) => {
      const { container } = render(() => (
        <DirectPresence bot={false} presence={presence} />
      ));

      const line = container.querySelector("[data-direct-presence]");
      expect(line).toHaveTextContent(`Direct message · ${presence}`);
      expect(line?.querySelector("[data-presence-dot]")).toHaveAttribute(
        "data-presence",
        presence,
      );
    },
  );

  it("shows its fallback while the peer's presence is unknown", () => {
    const { container } = render(() => (
      <DirectPresence
        bot={false}
        fallback={<span>Direct message</span>}
        presence={undefined}
      />
    ));

    expect(container).toHaveTextContent("Direct message");
    expect(container.querySelector("[data-direct-presence]")).toBeNull();
  });

  it("marks a bot with its robot", () => {
    const { container } = render(() => (
      <DirectPresence bot presence="offline" />
    ));

    const line = container.querySelector("[data-direct-presence]");
    expect(line).toHaveTextContent("Direct message · offline");
    expect(line?.querySelector("[data-peer-bot]")).toHaveAttribute(
      "data-presence",
      "offline",
    );
  });
});
