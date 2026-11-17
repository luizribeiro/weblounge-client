import { render } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { ChairMark } from "./ChairMark";

it("is a decorative tile that keeps the caller's class, attributes and layers", () => {
  const { container } = render(() => (
    <ChairMark class="logo" data-connection-logo="true">
      <span data-connection-fill="true" />
    </ChairMark>
  ));

  const mark = container.firstElementChild;
  expect(mark).toHaveAttribute("aria-hidden", "true");
  expect(mark).toHaveClass("logo");
  expect(mark?.classList).toHaveLength(2);
  expect(mark).toHaveAttribute("data-connection-logo", "true");
  expect(mark?.querySelector("[data-connection-fill]")).not.toBeNull();
});

it("carries only the tile class without one", () => {
  const { container } = render(() => <ChairMark />);

  expect(container.firstElementChild?.getAttribute("class")).not.toMatch(/\s/u);
  expect(container.firstElementChild?.childElementCount).toBe(0);
});
