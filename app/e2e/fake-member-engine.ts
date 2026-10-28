import type { EnginePort } from "../src/engine/EngineClient";
import type { EngineToUi, UiToEngine } from "../src/engine/protocol";
import type { MemberWindow } from "../src/features/members/MemberPanel";

type Member = MemberWindow["members"][number];
export type MemberChange = "join" | "mode" | "split";
const windowSize = 200;

export class FakeMemberPort implements EnginePort {
  readonly #listeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly #views = new Map<string, { buffer: number; offset: number }>();
  #members = Array.from({ length: 2_000 }, (_, index) =>
    member(`u${index.toString().padStart(4, "0")}`),
  );
  #version = 0;
  patches = 0;

  postMessage(message: UiToEngine) {
    if (message.type === "hello") {
      queueMicrotask(() =>
        this.#emit({ type: "ready", engine_instance: "fake", revision: 0 }),
      );
      return;
    }
    const { command, id } = message.payload;
    if (command.type === "request_members") {
      this.#views.set(command.view_id, {
        buffer: command.buffer_id,
        offset: command.offset,
      });
      queueMicrotask(() => this.#emitWindow(command.view_id));
    }
    queueMicrotask(() => this.#emit({ type: "command_result", id }));
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    this.#listeners.add(listener);
  }
  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    this.#listeners.delete(listener);
  }

  change(change: MemberChange) {
    if (change === "join") this.#members.push(member("a-new"));
    if (change === "mode")
      this.#members = this.#members.map((item) =>
        item.nick === "u1500"
          ? { ...item, group: "operators", mode_symbol: "@" }
          : item,
      );
    if (change === "split")
      this.#members = this.#members.filter(
        (item) => !/^u0[0-4]\d\d$/.test(item.nick),
      );
    this.#version += 1;
    for (const view of this.#views.keys()) {
      this.patches += 1;
      this.#emitWindow(view);
    }
  }

  #emitWindow(viewId: string) {
    const view = this.#views.get(viewId);
    if (view === undefined) return;
    const members = [...this.#members].sort(compareMembers);
    const counts = ["operators", "voiced", "online", "away", "bots"].map(
      (group) => members.filter((item) => item.group === group).length,
    ) as [number, number, number, number, number];
    this.#emit({
      type: "members_changed",
      buffer_id: view.buffer,
      view_id: viewId,
      version: this.#version,
      window_size: windowSize,
      offset: view.offset,
      total: members.length,
      counts,
      members: members.slice(view.offset, view.offset + windowSize),
    });
  }

  #emit(message: EngineToUi) {
    const event = new MessageEvent("message", { data: message });
    for (const listener of this.#listeners) listener(event);
  }
}

function member(nick: string): Member {
  return {
    group: "online",
    nick,
    mode_symbol: null,
    away: false,
    bot: false,
    account: null,
    nick_color_index: 0,
    is_you: false,
  };
}

function compareMembers(first: Member, second: Member) {
  const order = { operators: 0, voiced: 1, online: 2, away: 3, bots: 4 };
  return (
    order[first.group] - order[second.group] ||
    first.nick.localeCompare(second.nick)
  );
}
