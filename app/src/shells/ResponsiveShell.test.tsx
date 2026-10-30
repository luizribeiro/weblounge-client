import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import type { BufferProjection } from "../engine/protocol";
import { ResponsiveShell } from "./ResponsiveShell";

const fallback = buffer(2, "#fallback");
const routed = buffer(3, "#routed");
const server: BufferProjection = {
  ...buffer(1, "Local"),
  kind: "server",
};

it("replaces a provisional fallback when a pending route resolves", async () => {
  const [activeBufferId, setActiveBufferId] = createSignal<number>();
  const [buffers, setBuffers] = createSignal<readonly BufferProjection[]>([]);
  render(() => shell(activeBufferId, buffers));

  setBuffers([server]);
  expect(await screen.findByRole("heading", { name: "Local" })).toBeVisible();

  setBuffers([server, fallback]);
  expect(
    await screen.findByRole("heading", { name: "#fallback" }),
  ).toBeVisible();

  setBuffers([server, fallback, routed]);
  setActiveBufferId(routed.id);
  expect(await screen.findByRole("heading", { name: "#routed" })).toBeVisible();
});

it("keeps an engine focus request through a later buffer snapshot", async () => {
  const [buffers, setBuffers] = createSignal<readonly BufferProjection[]>([
    fallback,
    routed,
  ]);
  const [focusRequest, setFocusRequest] = createSignal<
    { readonly bufferId: number } | undefined
  >();
  render(() => shell(() => undefined, buffers, focusRequest));

  setFocusRequest({ bufferId: routed.id });
  expect(await screen.findByRole("heading", { name: "#routed" })).toBeVisible();

  setBuffers([buffer(4, "#earlier"), fallback, routed]);
  expect(screen.getByRole("heading", { name: "#routed" })).toBeVisible();
});

it("keeps a user click when a pending route later resolves", async () => {
  const [activeBufferId, setActiveBufferId] = createSignal<number>();
  render(() => shell(activeBufferId, () => [fallback, routed]));

  fireEvent.click(screen.getByRole("button", { name: "#routed" }));
  expect(await screen.findByRole("heading", { name: "#routed" })).toBeVisible();

  setActiveBufferId(fallback.id);
  expect(screen.getByRole("heading", { name: "#routed" })).toBeVisible();
});

function shell(
  activeBufferId: () => number | undefined,
  buffers: () => readonly BufferProjection[],
  focusRequest: () => { readonly bufferId: number } | undefined = () =>
    undefined,
) {
  return (
    <ResponsiveShell
      activeBufferId={activeBufferId()}
      buffers={buffers()}
      composerNotice={undefined}
      completion={undefined}
      focusRequest={focusRequest()}
      memberships={new Map()}
      messages={new Map()}
      networks={[{ id: 1, label: "Local", nickname: "me", state: "online" }]}
      onLoadHistory={() => {}}
      onMarkRead={() => {}}
      onRequestCompletion={() => {}}
      onSend={async () => true}
    />
  );
}

function buffer(id: number, title: string): BufferProjection {
  return {
    id,
    network_id: 1,
    kind: "channel",
    title,
    draft_key: `1:${title}`,
    topic: null,
    unread: 0,
    mentions: 0,
    read_through: null,
  };
}
