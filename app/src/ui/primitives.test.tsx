import { render, screen } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { Line } from "./Line";
import { Selectable } from "./Selectable";

it("marks selectable content and preserves element attributes", () => {
  render(() => (
    <Selectable class="message-copy" lang="en" surfaceId="message-1">
      Select this message
    </Selectable>
  ));

  const content = screen.getByText("Select this message");
  expect(content).toHaveAttribute("data-selectable", "true");
  expect(content).toHaveAttribute("lang", "en");
  expect(content).toHaveClass("message-copy");
});

it("renders a structural single-line slot", () => {
  render(() => (
    <Line class="topic" title="A long topic">
      A long topic
    </Line>
  ));

  const line = screen.getByTitle("A long topic");
  expect(line).toHaveAttribute("data-line", "true");
  expect(line).toHaveClass("topic");
});
