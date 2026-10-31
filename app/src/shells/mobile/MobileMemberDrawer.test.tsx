import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { MobileMemberDrawer, swipeClosesDrawer } from "./MobileMemberDrawer";

it("renders a modal touch drawer with shared member contents", async () => {
  const close = vi.fn();
  render(() => (
    <MobileMemberDrawer
      bufferTitle="#room"
      filter=""
      onClose={close}
      onFilter={() => {}}
      onOpenDirect={() => {}}
      onRequestRange={() => {}}
      window={undefined}
    />
  ));
  expect(screen.getByRole("dialog", { name: "Members" })).toHaveAttribute(
    "aria-modal",
    "true",
  );
  await Promise.resolve();
  expect(
    screen.getByRole("searchbox", { name: "Filter members" }),
  ).not.toHaveFocus();
  fireEvent.click(
    screen.getAllByRole("button", { name: "Close member list" })[0] as Element,
  );
  expect(close).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
});

it("closes on a deliberate or fast right swipe", () => {
  expect(swipeClosesDrawer(119, 300, 0.2)).toBe(false);
  expect(swipeClosesDrawer(120, 300, 0.2)).toBe(false);
  expect(swipeClosesDrawer(121, 300, 0.2)).toBe(true);
  expect(swipeClosesDrawer(40, 300, 0.5)).toBe(true);
});
