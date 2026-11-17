import { render } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { ChairMark } from "./ChairMark";

it("is a decorative chair that keeps the caller's class and attributes", () => {
  const { container } = render(() => (
    <ChairMark class="logoMark" data-connection-logo-mark="true" />
  ));

  const mark = container.firstElementChild;
  expect(mark).toHaveAttribute("aria-hidden", "true");
  expect(mark).toHaveClass("logoMark");
  expect(mark?.classList).toHaveLength(2);
  expect(mark).toHaveAttribute("data-connection-logo-mark", "true");
});

it("carries only the chair class without one", () => {
  const { container } = render(() => <ChairMark />);

  expect(container.firstElementChild?.getAttribute("class")).not.toMatch(/\s/u);
});
