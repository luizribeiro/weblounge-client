import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { MemberPanel, type MemberWindow } from "./MemberPanel";
import type { Member } from "./MemberRow";

const member: Member = {
  group: "operators",
  nick: "weblounge",
  mode_symbol: "@",
  away: false,
  bot: false,
  account: "weblounge",
  nick_color_index: 0,
  is_you: true,
};
const window: MemberWindow = {
  type: "members_changed",
  buffer_id: 2,
  view_id: "test:desktop:pane-1",
  version: 0,
  window_size: 256,
  offset: 0,
  total: 10_000,
  counts: [1, 0, 9_999, 0, 0],
  members: [member],
};

it("renders counted groups with a bounded DOM and panel actions", async () => {
  const close = vi.fn();
  const open = vi.fn();
  const request = vi.fn();
  const { container } = render(() => (
    <MemberPanel
      bufferTitle="#room"
      window={window}
      onClose={close}
      onOpenDirect={open}
      onRequestRange={request}
    />
  ));
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(screen.getByText("Following").parentElement).toHaveTextContent(
    "Following #room",
  );
  expect(screen.getByText("Operators — 1")).toBeInTheDocument();
  expect(screen.getByText("@")).toBeInTheDocument();
  expect(container.querySelectorAll("li").length).toBeLessThan(80);
  expect(container.querySelector("[data-member-virtual-size]")).toHaveStyle({
    height: "240056px",
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Open direct message with weblounge" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Hide members" }));
  expect(open).toHaveBeenCalledWith("weblounge");
  expect(close).toHaveBeenCalledOnce();
});

it("passes the mode-symbol setting to member rows", () => {
  render(() => (
    <MemberPanel
      bufferTitle="#room"
      onClose={() => {}}
      onOpenDirect={() => {}}
      onRequestRange={() => {}}
      showModeSymbols={false}
      window={window}
    />
  ));
  expect(screen.queryByText("@")).not.toBeInTheDocument();
});

it("requests the first window while loading", () => {
  const request = vi.fn();
  render(() => (
    <MemberPanel
      bufferTitle="#room"
      window={undefined}
      onClose={() => {}}
      onOpenDirect={() => {}}
      onRequestRange={request}
    />
  ));
  expect(request).toHaveBeenCalledWith(0);
});

it("allows a newer member version to refill the same range", async () => {
  const request = vi.fn();
  const [current, setCurrent] = createSignal(window);
  render(() => (
    <MemberPanel
      bufferTitle="#room"
      window={current()}
      onClose={() => {}}
      onOpenDirect={() => {}}
      onRequestRange={request}
    />
  ));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(request).toHaveBeenCalledWith(0);

  setCurrent({ ...window, version: 1 });
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith(0);
});

it("filters into the matching casemapped engine window", () => {
  const filter = vi.fn();
  render(() => (
    <MemberPanel
      bufferTitle="#room"
      filter="web"
      onClose={() => {}}
      onFilter={filter}
      onOpenDirect={() => {}}
      onRequestRange={() => {}}
      window={{ ...window, filter: "web" }}
    />
  ));

  expect(screen.getByRole("searchbox", { name: "Filter members" })).toHaveValue(
    "web",
  );
  fireEvent.input(screen.getByRole("searchbox"), {
    target: { value: "garden" },
  });
  expect(filter).toHaveBeenCalledWith("garden");
});
