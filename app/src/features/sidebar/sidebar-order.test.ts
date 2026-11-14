import { describe, expect, it } from "vitest";
import {
  conversationRowIds,
  jumpSlotsById,
  sidebarRowIds,
  wrappedNeighbourId,
} from "./sidebar-order";

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

  it("numbers the first rows only, leaving later rows unnumbered", () => {
    const many = Array.from({ length: 11 }, (_, index) => ({
      id: 100 + index,
      network_id: 10,
      kind: "channel" as const,
    }));
    const slots = jumpSlotsById([{ id: 10 }], many, 9);

    expect([...slots.entries()]).toEqual(
      many.slice(0, 9).map((buffer, index) => [buffer.id, index + 1]),
    );
    expect(slots.has(109)).toBe(false);
    expect(slots.has(110)).toBe(false);
  });

  it("is empty before any network is known", () => {
    expect(conversationRowIds([], buffers)).toEqual([]);
    expect(sidebarRowIds([], buffers)).toEqual([]);
  });

  it("steps to the next and previous row, wrapping at both ends", () => {
    const ids = sidebarRowIds(networks, buffers);

    expect(wrappedNeighbourId(ids, 6, 1)).toBe(2);
    expect(wrappedNeighbourId(ids, 6, -1)).toBe(3);
    expect(wrappedNeighbourId(ids, 11, 1)).toBe(5);
    expect(wrappedNeighbourId(ids, 5, -1)).toBe(11);
  });

  it("steps from the first row when the current one is not drawn", () => {
    const ids = sidebarRowIds(networks, buffers);

    expect(wrappedNeighbourId(ids, 4, 1)).toBe(ids[1]);
    expect(wrappedNeighbourId(ids, undefined, -1)).toBe(11);
    expect(wrappedNeighbourId([], 1, 1)).toBeUndefined();
  });
});
