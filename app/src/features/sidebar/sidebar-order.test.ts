import { describe, expect, it } from "vitest";
import { conversationRowIds, sidebarRowIds } from "./sidebar-order";

const networks = [{ id: 20 }, { id: 10 }, { id: 30 }];
const buffers = [
  { id: 1, network_id: 10, kind: "channel" as const },
  { id: 2, network_id: 10, kind: "server" as const },
  { id: 3, network_id: 20, kind: "direct" as const },
  { id: 4, network_id: 20, kind: "channel" as const, available: false },
  { id: 5, network_id: 20, kind: "server" as const },
  { id: 6, network_id: 20, kind: "channel" as const },
  { id: 7, network_id: 99, kind: "channel" as const },
  { id: 8, network_id: 10, kind: "direct" as const },
  { id: 9, network_id: 10, kind: "channel" as const },
  { id: 11, network_id: 30, kind: "channel" as const },
];

describe("sidebar order", () => {
  it("lists each network's header before its rows in projection order, skipping hidden and unknown-network buffers", () => {
    expect(sidebarRowIds(networks, buffers)).toEqual([5, 3, 6, 2, 1, 8, 9, 11]);
  });

  it("numbers only visible conversation rows, top to bottom across networks, keeping a direct between channels where it is drawn", () => {
    expect(conversationRowIds(networks, buffers)).toEqual([3, 6, 1, 8, 9, 11]);
  });

  it("is empty before any network is known", () => {
    expect(conversationRowIds([], buffers)).toEqual([]);
    expect(sidebarRowIds([], buffers)).toEqual([]);
  });
});
