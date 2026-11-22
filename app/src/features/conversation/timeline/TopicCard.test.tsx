import { render, screen } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { TopicCard, type TopicCardEvent, topicCardMeta } from "./TopicCard";

const setAt = Date.UTC(2026, 10, 3, 12);
const card: TopicCardEvent = {
  type: "topic_card",
  topic: "weblounge 0.9 beta · push works on iOS",
  setter: "mel",
  set_at_ms: setAt,
};

it("shows the topic under a Topic title with who set it and when", () => {
  render(() => (
    <TopicCard
      card={card}
      presentation="desktop"
      renderText={(text) => <span data-rendered-text>{text}</span>}
      timeMs={setAt + 86_400_000}
    />
  ));

  const region = screen.getByRole("region", {
    name: `Topic. ${card.topic}. ${topicCardMeta(card)}`,
  });
  expect(region).toHaveAttribute("data-system-card", "topic");
  expect(region.querySelector("[data-rendered-text]")).toHaveTextContent(
    card.topic,
  );
  expect(
    region.querySelector("[data-rendered-text]")?.closest("[data-selectable]"),
  ).not.toBeNull();
  expect(topicCardMeta(card)).toBe(
    `set by mel · ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(setAt)}`,
  );
});

it("says no topic is set and omits unknown setter facts", () => {
  const empty = { ...card, topic: "", setter: null, set_at_ms: null };
  render(() => (
    <TopicCard
      card={empty}
      presentation="mobile"
      renderText={(text) => <span data-rendered-text>{text}</span>}
      timeMs={setAt}
    />
  ));

  const region = screen.getByRole("region", {
    name: "Topic. No topic is set.",
  });
  expect(region).toHaveAttribute("data-presentation", "mobile");
  expect(region.querySelector("[data-rendered-text]")).toBeNull();
  expect(topicCardMeta(empty)).toBe("");
});
