import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { formatTime } from "../../ui/format-time";
import { DirectPresence } from "./DirectPresence";

describe("DirectPresence", () => {
  it.each([
    ["online", "Online"],
    ["away", "Away"],
    ["offline", "Offline"],
  ] as const)("names a person's %s state with its dot", (presence, text) => {
    const { container } = render(() => (
      <DirectPresence bot={false} presence={presence} />
    ));

    const line = container.querySelector("[data-direct-presence]");
    expect(line).toHaveTextContent(text);
    expect(line?.querySelector("[data-presence-dot]")).toHaveAttribute(
      "data-presence",
      presence,
    );
  });

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

  it("says when a peer seen going offline was last seen", () => {
    const seen = Date.now();
    const { container } = render(() => (
      <DirectPresence bot={false} presence="offline" sinceMs={seen} />
    ));

    expect(container.querySelector("[data-direct-presence]")).toHaveTextContent(
      `Offline, last seen ${formatTime(seen)}`,
    );
  });

  it("marks a bot with its robot", () => {
    const { container } = render(() => (
      <DirectPresence bot presence="offline" />
    ));

    const line = container.querySelector("[data-direct-presence]");
    expect(line).toHaveTextContent("Offline");
    expect(line?.querySelector("[data-peer-bot]")).toHaveAttribute(
      "data-presence",
      "offline",
    );
  });
});
