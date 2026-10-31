import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import { MobileScreen } from "./MobileScreen";
import type { MobileScreen as Screen } from "./mobile-navigation";
import type { PushMotion } from "./push-motion";

vi.mock("./MobileChatList", () => ({
  MobileChatList: (props: { readonly onOpen: (bufferId: number) => void }) => (
    <button onClick={() => props.onOpen(2)} type="button">
      Chats route
    </button>
  ),
}));

vi.mock("./MobileConversation", () => ({
  MobileConversation: (props: { readonly buffer: BufferProjection }) => (
    <div data-routed-chat={props.buffer.id}>{props.buffer.title}</div>
  ),
}));

const buffer: BufferProjection = {
  id: 2,
  network_id: 1,
  kind: "direct",
  title: "mel",
  draft_key: "mel",
  topic: null,
  unread: 0,
  mentions: 0,
  read_through: null,
};

it("routes the chats root to the mobile chat list", () => {
  const open = vi.fn();
  renderRoute({ kind: "chats" }, [buffer], open);

  fireEvent.click(screen.getByRole("button", { name: "Chats route" }));
  expect(open).toHaveBeenCalledWith(2);
  expect(document.querySelector("[data-routed-chat]")).toBeNull();
});

it("routes a chat screen to its projected buffer", () => {
  renderRoute({ kind: "chat", bufferId: 2 }, [buffer]);

  expect(document.querySelector("[data-routed-chat='2']")).toHaveTextContent(
    "mel",
  );
  expect(
    screen.queryByRole("button", { name: "Chats route" }),
  ).not.toBeInTheDocument();
});

it("renders no destination for a stale chat buffer id", () => {
  renderRoute({ kind: "chat", bufferId: 99 }, [buffer]);

  expect(document.querySelector("[data-routed-chat]")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Chats route" }),
  ).not.toBeInTheDocument();
});

it("exposes its motion phase and the shared offset", async () => {
  const settled = vi.fn();
  renderRoute(
    { kind: "chat", bufferId: 2 },
    [buffer],
    vi.fn(),
    { phase: "dragging", progress: 0.4 },
    settled,
  );
  const element = document.querySelector<HTMLElement>("[data-motion]");

  expect(element).toHaveAttribute("data-motion", "dragging");
  expect(element?.style.getPropertyValue("--wl-push-offset")).toBe("0.4");
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
});

it("settles a resting phase when no transform transition runs", async () => {
  const settled = vi.fn();
  renderRoute(
    { kind: "chat", bufferId: 2 },
    [buffer],
    vi.fn(),
    { phase: "closing" },
    settled,
  );

  await Promise.resolve();
  expect(settled).toHaveBeenCalledOnce();
});

it("settles only on its own transform transition", () => {
  const settled = vi.fn();
  renderRoute(
    { kind: "chat", bufferId: 2 },
    [buffer],
    vi.fn(),
    { phase: "entering" },
    settled,
  );
  const element = document.querySelector("[data-motion]");
  if (element === null) throw new Error("moving screen is missing");
  const transitionEnd = (propertyName: string) =>
    Object.assign(new Event("transitionend", { bubbles: true }), {
      propertyName,
    });

  element.dispatchEvent(transitionEnd("opacity"));
  element.firstElementChild?.dispatchEvent(transitionEnd("transform"));
  expect(settled).not.toHaveBeenCalled();
  element.dispatchEvent(transitionEnd("transform"));
  expect(settled).toHaveBeenCalledOnce();
});

function renderRoute(
  route: Screen,
  buffers: readonly BufferProjection[],
  onOpen = vi.fn(),
  motion?: PushMotion,
  onMotionEnd = vi.fn(),
) {
  return render(() => (
    <MobileScreen
      buffers={buffers}
      chatsScrollTop={() => 0}
      chatsScrollVersion={() => 0}
      composerNotice={undefined}
      completion={undefined}
      filter="all"
      memberships={new Map()}
      messages={new Map()}
      networks={[]}
      onBack={() => {}}
      onFilter={() => {}}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onOpen={onOpen}
      onQuery={() => {}}
      onRequestCompletion={() => {}}
      onScroll={() => {}}
      onSend={async () => true}
      motion={motion}
      onMotionEnd={onMotionEnd}
      query=""
      screen={route}
    />
  ));
}
