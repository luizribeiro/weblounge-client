import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChairMark } from "./ChairMark";

const root = document.documentElement;
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => {
  delete root.dataset.theme;
});

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

it("is not a control in other themes", () => {
  root.dataset.theme = "black";
  render(() => <ChairMark />);

  expect(screen.queryByRole("button")).toBeNull();
});

describe("in the n.e. theme", () => {
  beforeEach(() => {
    root.dataset.theme = "ne";
  });

  it("flips to the blob and back as a toggle button around the same tile", () => {
    render(() => (
      <ChairMark class="logo" data-connection-logo="true">
        <span data-connection-fill="true" />
      </ChairMark>
    ));

    const button = screen.getByRole("button", { name: "Flip the logo" });
    expect(button).toHaveClass("logo");
    expect(button).toHaveAttribute("aria-pressed", "false");
    const tile = button.querySelector("[data-connection-logo]");
    expect(tile).toHaveAttribute("aria-hidden", "true");
    expect(tile).toHaveClass("logo");
    expect(tile?.querySelector("[data-connection-fill]")).not.toBeNull();

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("leaves focus where it was when pressed with a pointer", () => {
    render(() => <ChairMark />);

    expect(fireEvent.mouseDown(screen.getByRole("button"))).toBe(false);
  });

  it("shows the chair again, unflipped, once the theme changes", async () => {
    render(() => <ChairMark />);
    fireEvent.click(screen.getByRole("button"));

    root.dataset.theme = "black";
    await settle();
    expect(screen.queryByRole("button")).toBeNull();

    root.dataset.theme = "ne";
    await settle();
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  });
});
