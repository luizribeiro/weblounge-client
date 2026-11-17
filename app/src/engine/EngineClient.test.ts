import { describe, expect, it, vi } from "vitest";
import { switchesOn } from "./app-settings-fixture";
import {
  type EngineConnection,
  type EnginePort,
  WorkerEngineClient,
} from "./EngineClient";
import type { UiToEngine } from "./protocol";
import { requestReply } from "./request-reply";

class FakePort implements EnginePort {
  readonly sent: UiToEngine[] = [];
  readonly listeners = new Map<string, (event: Event) => void>();

  postMessage(message: UiToEngine): void {
    this.sent.push(message);
  }

  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.set(type, listener as (event: Event) => void);
  }

  removeEventListener(type: "message"): void {
    this.listeners.delete(type);
  }

  emit(message: unknown): void {
    this.listeners.get("message")?.(
      new MessageEvent("message", { data: message }),
    );
  }

  fail(type: "error" | "messageerror" = "messageerror"): void {
    this.listeners.get(type)?.(new Event(type));
  }
}

function fixture() {
  const port = new FakePort();
  const close = vi.fn();
  const connection: EngineConnection = { port, close };
  const frames: FrameRequestCallback[] = [];
  const client = new WorkerEngineClient(connection, (callback) => {
    frames.push(callback);
    return frames.length;
  });
  return { client, close, frames, port };
}

function notice(key: string) {
  return { type: "notice", key, values: {}, tone: "neutral", action: null };
}

describe("WorkerEngineClient", () => {
  it("completes the build handshake", async () => {
    const { client, port } = fixture();
    const started = client.start({
      build_id: "build-1",
      client_id: "tab-1",
      last_revision: null,
      shell: "web",
    });

    expect(port.sent).toEqual([
      {
        type: "hello",
        payload: {
          build_id: "build-1",
          client_id: "tab-1",
          last_revision: null,
          shell: "web",
        },
      },
    ]);
    port.emit({ type: "ready", engine_instance: "engine-1", revision: 0 });

    await expect(started).resolves.toBeUndefined();
  });

  it("pings only after a hidden client becomes visible", async () => {
    const { client, port } = fixture();
    const started = client.start({
      build_id: "build-1",
      client_id: "tab-1",
      last_revision: null,
      shell: "web",
    });
    port.emit({ type: "ready", engine_instance: "engine-1", revision: 0 });
    await started;
    port.sent.length = 0;

    client.setVisibility("hidden");
    client.checkLiveness();
    expect(port.sent).toEqual([]);
    client.setVisibility("visible");

    expect(port.sent).toHaveLength(1);
    const heartbeat = port.sent[0];
    expect(heartbeat).toMatchObject({
      type: "request",
      payload: { request: { type: "ping" } },
    });
    if (heartbeat?.type !== "request")
      throw new Error("heartbeat is a request");
    port.emit({ type: "pong", id: heartbeat.payload.id });
    await client.close();
  });

  it("does not probe a worker whose handshake is still pending", async () => {
    vi.useFakeTimers();
    try {
      const first = new FakePort();
      const second = new FakePort();
      const closeFirst = vi.fn();
      const client = new WorkerEngineClient(
        { port: first, close: closeFirst },
        undefined,
        [],
        () => ({ port: second, close: vi.fn() }),
      );
      const hello = {
        build_id: "build-1",
        client_id: "tab-1",
        last_revision: null,
        shell: "web" as const,
      };
      const started = client.start(hello);

      client.setVisibility("hidden");
      client.setVisibility("visible");
      vi.advanceTimersByTime(6_000);

      expect(first.sent).toEqual([{ type: "hello", payload: hello }]);
      expect(closeFirst).not.toHaveBeenCalled();
      first.fail();
      expect(second.sent).toEqual([{ type: "hello", payload: hello }]);
      second.emit({ type: "ready", engine_instance: "engine-2", revision: 0 });
      await started;
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("respawns a failed worker and repeats the handshake", async () => {
    const first = new FakePort();
    const second = new FakePort();
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    const connections = [{ port: second, close: closeSecond }];
    const client = new WorkerEngineClient(
      { port: first, close: closeFirst },
      (callback) => {
        callback(0);
        return 1;
      },
      [],
      () => {
        const connection = connections.shift();
        if (connection === undefined) throw new Error("no replacement");
        return connection;
      },
    );
    const hello = {
      build_id: "build-1",
      client_id: "tab-1",
      last_revision: null,
      shell: "web" as const,
    };
    const started = client.start(hello);
    first.emit({ type: "ready", engine_instance: "engine-1", revision: 0 });
    await started;
    const listener = vi.fn();
    client.subscribe(listener);

    first.fail();

    expect(closeFirst).toHaveBeenCalledOnce();
    expect(second.sent).toEqual([{ type: "hello", payload: hello }]);
    second.emit({ type: "ready", engine_instance: "engine-2", revision: 0 });
    expect(listener).toHaveBeenCalledWith({
      type: "ready",
      engine_instance: "engine-2",
      revision: 0,
    });
    await client.close();
    expect(closeSecond).toHaveBeenCalledOnce();
  });

  it("resolves a command while preserving subscriber emission order", async () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const result = client.send({
      id: "command-1",
      request: { type: "diagnostic", message: "worker alive" },
    });

    port.emit({
      type: "diagnostic",
      command_id: "command-1",
      message: "worker alive",
    });
    port.emit({ type: "command_result", id: "command-1" });

    await expect(result).resolves.toEqual({
      type: "command_result",
      id: "command-1",
    });
    expect(listener).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls.map(([message]) => message.type)).toEqual([
      "diagnostic",
      "command_result",
    ]);
  });

  it("rejects a command with the engine's typed message key", async () => {
    const { client, port } = fixture();
    const result = client.send({
      id: "connect-again",
      request: { type: "diagnostic", message: "ignored" },
    });

    port.emit({
      type: "command_rejected",
      id: "connect-again",
      message_key: "engine.network_already_connected",
      values: { target: "#garden" },
    });

    await expect(result).rejects.toMatchObject({
      messageKey: "engine.network_already_connected",
      values: { target: "#garden" },
    });
  });

  it("decodes engine-owned completion candidates", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const command = {
      type: "completion_result",
      command_id: "complete-1",
      buffer_id: 4,
      input: "/j",
      replace_start: 0,
      replace_end: 2,
      trigger: "command",
      argument_hint: null,
      replacement_prefix: "/",
      replacement_suffix: " ",
      auto_accept: false,
      candidates: [
        {
          type: "command",
          name: "join",
          usage: "cmd.join.usage",
          description: "cmd.join.description",
        },
      ],
    };
    const typedMention = {
      ...command,
      command_id: "complete-2",
      input: "@Ana ",
      replace_end: 5,
      trigger: "person",
      replacement_prefix: "",
      replacement_suffix: ": ",
      auto_accept: true,
      candidates: [
        {
          type: "person",
          nick: "ana",
          nick_color_index: 3,
          away: false,
          bot: null,
        },
      ],
    };
    const { auto_accept: _, ...withoutAcceptance } = typedMention;

    port.emit(command);
    port.emit(typedMention);
    expect(() => port.emit(withoutAcceptance)).toThrow(
      "invalid engine message",
    );
    frames[0]?.(0);

    expect(listener.mock.calls).toEqual([[command], [typedMention]]);
  });

  it("decodes typed local notice messages", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const notice = {
      id: 9,
      author: "weblounge",
      text: "A quiet place",
      kind: {
        notice: { type: "info" },
      },
      bot: false,
      authorship: "own",
      nick_color_index: 0,
      highlighted: false,
      reactions: [
        {
          text: "👍",
          actors: [{ nick: "mel", mine: false }],
          mine: false,
        },
        {
          text: "🎉",
          actors: [{ nick: "weblounge", mine: true }],
          mine: true,
          own_delivery: "sending",
        },
      ],
      delivery: "received",
      local_send_id: null,
      server_ids: [],
      server_time_ms: 20,
      received_at_ms: 30,
    };

    const appended = {
      type: "timeline_changed",
      buffer_id: 2,
      reset: false,
      upserted: [timelineMessage(notice)],
      removed: [],
    };
    const updated = {
      ...appended,
      upserted: [timelineMessage({ ...notice, server_time_ms: 10 })],
    };
    port.emit(appended);
    port.emit(updated);
    frames[0]?.(0);

    expect(listener.mock.calls.map(([message]) => message)).toEqual([
      appended,
      updated,
    ]);
  });

  it("decodes IRC notice messages", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const notice = {
      id: 10,
      author: "NickServ",
      text: "This nickname is registered",
      kind: { irc_notice: "service" },
      bot: false,
      authorship: "other",
      nick_color_index: 0,
      highlighted: false,
      delivery: "received",
      local_send_id: null,
      server_ids: ["notice-1"],
      server_time_ms: 20,
      received_at_ms: 30,
    };

    const patch = {
      type: "timeline_changed",
      buffer_id: 2,
      reset: false,
      upserted: [timelineMessage(notice)],
      removed: [],
    };
    port.emit(patch);
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith(patch);
  });

  it("delivers a deletion at once, even while the page is hidden", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    port.emit({ type: "message_redacted", msgids: ["gone-1"] });
    expect(() =>
      port.emit({ type: "message_redacted", msgids: "gone-1" }),
    ).toThrow("invalid engine message");

    expect(frames).toHaveLength(0);
    expect(listener).toHaveBeenCalledWith({
      type: "message_redacted",
      msgids: ["gone-1"],
    });
  });

  it("decodes a pending own deletion and rejects an unknown state", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const own = {
      id: 12,
      author: "weblounge",
      text: "take this back",
      kind: "text",
      bot: null,
      authorship: "own",
      nick_color_index: 0,
      highlighted: false,
      own_redaction: "sending",
      delivery: "confirmed",
      local_send_id: null,
      server_ids: ["mine-1"],
      server_time_ms: 20,
      received_at_ms: 30,
    };
    const patch = {
      type: "timeline_changed",
      buffer_id: 2,
      reset: false,
      upserted: [timelineMessage(own)],
      removed: [],
    };

    port.emit(patch);
    expect(() =>
      port.emit({
        ...patch,
        upserted: [timelineMessage({ ...own, own_redaction: "done" })],
      }),
    ).toThrow("invalid engine message");
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith(patch);
  });

  it("decodes redacted messages and rejects a malformed redactor", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const redacted = {
      id: 11,
      author: "alice",
      text: "",
      kind: { redacted: { by: "op" } },
      bot: null,
      authorship: "other",
      nick_color_index: 0,
      highlighted: false,
      delivery: "received",
      local_send_id: null,
      server_ids: ["gone-1"],
      server_time_ms: 20,
      received_at_ms: 30,
    };
    const patch = {
      type: "timeline_changed",
      buffer_id: 2,
      reset: false,
      upserted: [timelineMessage(redacted)],
      removed: [],
    };

    port.emit(patch);
    expect(() =>
      port.emit({
        ...patch,
        upserted: [timelineMessage({ ...redacted, kind: { redacted: {} } })],
      }),
    ).toThrow("invalid engine message");
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith(patch);
  });

  it("decodes a network's optional file host origin", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const network = {
      id: 1,
      label: "Local Ergo",
      nickname: "weblounge",
      state: "online",
    };

    port.emit({ type: "network_state_changed", network });
    port.emit({
      type: "network_state_changed",
      network: { ...network, filehost_origin: "https://files.example.test" },
    });
    port.emit({
      type: "network_state_changed",
      network: { ...network, account: "weblounge" },
    });
    expect(() =>
      port.emit({
        type: "network_state_changed",
        network: { ...network, filehost_origin: 42 },
      }),
    ).toThrow("invalid engine message");
    expect(() =>
      port.emit({
        type: "network_state_changed",
        network: { ...network, account: 7 },
      }),
    ).toThrow("invalid engine message");
    frames[0]?.(0);

    expect(listener.mock.calls.map(([message]) => message)).toEqual([
      { type: "network_state_changed", network },
      {
        type: "network_state_changed",
        network: { ...network, filehost_origin: "https://files.example.test" },
      },
      {
        type: "network_state_changed",
        network: { ...network, account: "weblounge" },
      },
    ]);
  });

  it("decodes whether a network can send reactions and deletions", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const network = {
      id: 1,
      label: "Local Ergo",
      nickname: "weblounge",
      state: "online",
      can_react: true,
      can_redact: true,
    };

    port.emit({ type: "network_state_changed", network });
    for (const invalid of [{ can_react: "yes" }, { can_redact: 1 }])
      expect(() =>
        port.emit({
          type: "network_state_changed",
          network: { ...network, ...invalid },
        }),
      ).toThrow("invalid engine message");
    frames[0]?.(0);

    expect(listener.mock.calls.map(([message]) => message)).toEqual([
      { type: "network_state_changed", network },
    ]);
  });

  it("decodes the engine runtime command registry", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    port.emit({
      type: "command_specs_changed",
      specs: [
        {
          name: "help",
          aliases: ["?"],
          arguments: [
            { name: "command", kind: "command_name", required: false },
          ],
          usage: "cmd.help.usage",
          description: "cmd.help.description",
          requirements: [{ type: "connected" }],
          permission: "anyone",
          surfaces: ["slash", "palette"],
          confirm: "none",
          secret_arguments: false,
        },
      ],
    });
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "command_specs_changed",
        specs: [expect.objectContaining({ name: "help" })],
      }),
    );
  });

  it("decodes push registration outcomes and route replacement requests", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    const messages = [
      {
        type: "push_state_changed",
        network_id: 1,
        state: { status: "registered", route_id: "route-1" },
      },
      {
        type: "push_state_changed",
        network_id: 1,
        state: {
          status: "failed",
          route_id: "route-1",
          reason: "web_push_forbidden",
        },
      },
      {
        type: "push_route_required",
        network_id: 1,
        vapid: "new-home-key",
        previous_route_id: "route-1",
      },
      {
        type: "push_route_required",
        network_id: 2,
        vapid: "first-home-key",
        previous_route_id: null,
      },
    ];
    for (const message of messages) port.emit(message);
    frames[0]?.(0);

    expect(listener.mock.calls.map(([message]) => message)).toEqual(messages);
  });

  it("decodes durable push device credentials", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    port.emit({
      type: "push_device_loaded",
      command_id: "load-device",
      credentials: {
        relay: "https://push.example.test",
        device_id: "device-1",
        secret: "device-secret",
      },
    });
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith({
      type: "push_device_loaded",
      command_id: "load-device",
      credentials: {
        relay: "https://push.example.test",
        device_id: "device-1",
        secret: "device-secret",
      },
    });
  });

  it("decodes the device-local notification prompt preference", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    port.emit({
      type: "notification_prompt_dismissal_loaded",
      command_id: "load-prompt",
      dismissed: true,
    });
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith({
      type: "notification_prompt_dismissal_loaded",
      command_id: "load-prompt",
      dismissed: true,
    });
  });

  it("decodes settings loads and settings changes", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const settings = {
      app: {
        theme: "lounge-night",
        message_density: "compact",
        ...switchesOn,
      },
    };
    port.emit({ type: "settings_changed", settings });
    port.emit({ type: "settings_loaded", command_id: "load", settings });
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith({
      type: "settings_changed",
      settings,
    });
    expect(listener).toHaveBeenCalledWith({
      type: "settings_loaded",
      command_id: "load",
      settings,
    });
  });

  it("rejects settings with an unknown theme", () => {
    const { port } = fixture();

    expect(() =>
      port.emit({
        type: "settings_changed",
        settings: {
          app: {
            theme: "neon",
            message_density: "cozy",
            ...switchesOn,
          },
        },
      }),
    ).toThrow("invalid engine message");
  });

  it("rejects an unknown push failure", () => {
    const { port } = fixture();

    expect(() =>
      port.emit({
        type: "push_state_changed",
        network_id: 1,
        state: {
          status: "failed",
          route_id: "route-1",
          reason: "future_failure",
        },
      }),
    ).toThrow("invalid engine message");
  });

  it("preserves the casemapped member filter", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    port.emit({
      type: "members_changed",
      buffer_id: 4,
      view_id: "port-1:desktop:main",
      version: 7,
      window_size: 256,
      offset: 0,
      total: 0,
      counts: [0, 0, 0, 0, 0],
      members: [],
      filter: "{garden}",
    });
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: "{garden}",
        view_id: "port-1:desktop:main",
        version: 7,
        window_size: 256,
      }),
    );
  });

  it("preserves unknown member identity facts", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const message = {
      type: "members_changed",
      buffer_id: 4,
      view_id: "port-1:desktop:main",
      version: 7,
      window_size: 256,
      offset: 0,
      total: 1,
      counts: [0, 0, 1, 0, 0],
      members: [
        {
          group: "online",
          nick: "alice",
          mode_symbol: null,
          away: false,
          bot: null,
          account: { state: "unknown" },
          nick_color_index: 2,
          is_you: false,
        },
      ],
    };

    port.emit(message);
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith(message);
  });

  it("decodes bounded typing projections", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const message = {
      type: "typing_changed",
      buffer_id: 4,
      typers: [
        {
          nick: "alice",
          nick_color_index: 2,
          paused: true,
        },
      ],
    };

    port.emit(message);
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith(message);
  });

  it("delivers notifiable messages to a hidden page without a frame", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    client.setVisibility("hidden");
    const message = {
      type: "notifiable_message_received",
      buffer: {
        id: 4,
        network_id: 1,
        sync_state: "synced",
        kind: "direct",
        title: "alice",
        available: true,
        draft_key: "5:Local:rfc1459:alice",
        topic: null,
        unread: 2,
        mentions: 2,
      },
      message: {
        id: 12,
        author: "alice",
        text: "are you around?",
        kind: "text",
        bot: false,
        authorship: "other",
        nick_color_index: 3,
        highlighted: false,
        delivery: "received",
        local_send_id: null,
        server_ids: ["msg-12"],
        server_time_ms: 1_700_000_000_000,
        received_at_ms: 1_700_000_000_010,
      },
    };

    port.emit(message);

    expect(frames).toHaveLength(0);
    expect(listener).toHaveBeenCalledWith(message);
  });

  it("resolves an upload requested before the page was hidden", async () => {
    const { client, frames, port } = fixture();
    const resolution = requestReply(
      client,
      { type: "resolve_upload", network_id: 1, approval: null },
      (message, commandId) =>
        message.type === "upload_resolved" && message.command_id === commandId
          ? { value: message.resolution }
          : undefined,
    );
    const request = port.sent.find(
      (sent) =>
        sent.type === "request" &&
        sent.payload.request.type === "resolve_upload",
    );
    if (request?.type !== "request") throw new Error("no resolve request");
    client.setVisibility("hidden");

    port.emit({
      type: "upload_resolved",
      command_id: request.payload.id,
      resolution: {
        kind: "ready",
        endpoint: "https://files.weblounge.org/upload",
        authorization: { kind: "basic", header: "Basic d2VibG91bmdlOng=" },
      },
    });

    await expect(resolution).resolves.toEqual({
      kind: "ready",
      endpoint: "https://files.weblounge.org/upload",
      authorization: { kind: "basic", header: "Basic d2VibG91bmdlOng=" },
    });
    expect(frames).toHaveLength(0);
  });

  it("rejects unversioned member windows", () => {
    const { client, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    expect(() =>
      port.emit({
        type: "members_changed",
        buffer_id: 4,
        view_id: "port-1:desktop:main",
        offset: 0,
        total: 0,
        counts: [0, 0, 0, 0, 0],
        members: [],
      }),
    ).toThrow("invalid engine message");

    expect(listener).not.toHaveBeenCalled();
  });

  it("decodes the command origin of a buffer focus request", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    port.emit({
      type: "focus_buffer_requested",
      command_id: "join-1",
      buffer_id: 3,
    });
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith({
      type: "focus_buffer_requested",
      command_id: "join-1",
      buffer_id: 3,
    });
  });

  it("decodes a timeline reset for an attaching tab", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const reset = {
      type: "timeline_changed",
      buffer_id: 2,
      reset: true,
      upserted: [
        timelineMessage({
          id: 4,
          author: "louro",
          text: "long first\nlong second",
          kind: "text",
          bot: true,
          authorship: "other",
          nick_color_index: 3,
          highlighted: false,
          delivery: "received",
          local_send_id: null,
          server_ids: ["ml"],
          server_time_ms: 2,
          received_at_ms: 3,
        }),
      ],
      removed: [],
    };

    port.emit(reset);
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith(reset);
  });

  it("applies timeline patches by buffer before publishing them", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn((message) => {
      if (message.type === "timeline_changed")
        expect(client.timeline(2)?.items).toEqual([
          timelineGap(1, 10),
          timelineRun(2, 20),
        ]);
    });
    client.subscribe(listener);
    const patch = {
      type: "timeline_changed",
      buffer_id: 2,
      reset: false,
      upserted: [timelineGap(1, 10), timelineRun(2, 20)],
      removed: [],
    };

    port.emit(patch);
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith(patch);
    expect(client.timeline(2)).toEqual({
      items: [timelineGap(1, 10), timelineRun(2, 20)],
      geometry: "suffix",
      change: patch,
    });
    expect(client.timeline(3)).toBeUndefined();

    port.emit({ type: "buffer_removed", buffer_id: 2 });
    frames[1]?.(0);
    expect(client.timeline(2)).toBeUndefined();
  });

  it("decodes engine-owned stable draft keys", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    port.emit({
      type: "buffer_added",
      buffer: {
        id: 3,
        network_id: 1,
        sync_state: "synced" as const,
        kind: "channel",
        title: "#Room[",
        draft_key: "5:Local:rfc1459:#room{",
        topic: null,
        unread: 0,
        mentions: 0,
      },
    });
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: expect.objectContaining({
          draft_key: "5:Local:rfc1459:#room{",
        }),
      }),
    );
  });

  it("decodes direct-buffer nick palette indexes", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    port.emit({
      type: "buffer_added",
      buffer: {
        id: 4,
        network_id: 1,
        sync_state: "synced" as const,
        kind: "direct",
        title: "mel",
        nick_color_index: 7,
        draft_key: "5:Local:rfc1459:mel",
        topic: null,
        unread: 0,
        mentions: 0,
      },
    });
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: expect.objectContaining({ nick_color_index: 7 }),
      }),
    );
  });

  it("decodes legacy account draft migration into a nick thread", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    port.emit({
      type: "draft_key_changed",
      previous: "5:Local:rfc1459:account=alice-account",
      current: "5:Local:rfc1459:nick=alice",
    });
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith({
      type: "draft_key_changed",
      previous: "5:Local:rfc1459:account=alice-account",
      current: "5:Local:rfc1459:nick=alice",
    });
  });

  it("decodes direct identity state and unverified sender rows", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    port.emit({
      type: "buffer_added",
      buffer: {
        id: 4,
        network_id: 1,
        sync_state: "synced" as const,
        kind: "direct",
        title: "mel",
        direct_identity: "different_account",
        draft_key: "5:Local:rfc1459:nick=mel",
        topic: null,
        unread: 0,
        mentions: 0,
        last_message: {
          id: 8,
          author: "mel",
          text: "replacement",
          kind: "text",
          bot: false,
          authorship: "other",
          nick_color_index: 2,
          highlighted: false,
          unverified_sender: true,
          delivery: "received",
          local_send_id: null,
          server_ids: [],
          server_time_ms: null,
          received_at_ms: 1,
        },
      },
    });
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: expect.objectContaining({
          direct_identity: "different_account",
          last_message: expect.objectContaining({ unverified_sender: true }),
        }),
      }),
    );
  });

  it.each([
    { field: "peer_presence", valid: "away", invalid: "offline" },
    { field: "peer_bot", valid: true, invalid: "yes" },
  ])(
    "decodes a direct peer's $field and rejects invalid values",
    ({ field, valid, invalid }) => {
      const { client, frames, port } = fixture();
      const listener = vi.fn();
      client.subscribe(listener);
      const ana = {
        id: 5,
        network_id: 1,
        sync_state: "synced" as const,
        kind: "direct",
        title: "ana",
        draft_key: "5:Local:rfc1459:nick=ana",
        topic: null,
        unread: 0,
        mentions: 0,
      };

      port.emit({
        type: "buffer_updated",
        buffer: { ...ana, [field]: valid },
      });
      frames[0]?.(0);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          buffer: expect.objectContaining({ [field]: valid }),
        }),
      );
      expect(() =>
        port.emit({
          type: "buffer_updated",
          buffer: { ...ana, [field]: invalid },
        }),
      ).toThrow("invalid engine message");
    },
  );

  it("rejects a stale UI build", async () => {
    const { client, port } = fixture();
    const started = client.start({
      build_id: "stale",
      client_id: "tab-1",
      last_revision: null,
      shell: "web",
    });

    port.emit({ type: "incompatible_build", engine: "current", ui: "stale" });

    await expect(started).rejects.toThrow("does not match");
  });

  it("rejects an unknown engine message", () => {
    const { port } = fixture();

    expect(() => port.emit({ type: "future_variant" })).toThrow(
      "invalid engine message",
    );
  });

  it("decodes localized notice values and registry actions", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const event = {
      type: "notice",
      key: "notice.message_not_delivered",
      values: { network_id: "1", target: "ana" },
      tone: "error",
      action: { label: "action.open", run: "buffer.open" },
    };

    port.emit(event);
    frames[0]?.(0);

    expect(listener).toHaveBeenCalledWith(event);
  });

  it("publishes held events as soon as it becomes visible", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    client.setVisibility("hidden");

    port.emit(notice("first"));
    port.emit(notice("second"));

    expect(frames).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();

    client.setVisibility("visible");
    expect(frames).toHaveLength(0);
    expect(listener.mock.calls.map(([message]) => message.key)).toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps unread counts current while hidden but holds their timeline", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    client.setVisibility("hidden");

    port.emit(timelineChange(4, "ping while you are away"));
    port.emit(directBufferUpdate({ unread: 1, mentions: 1 }));

    expect(frames).toHaveLength(0);
    expect(publishedTypes(listener)).toEqual(["buffer_updated"]);

    client.setVisibility("visible");
    expect(publishedTypes(listener)).toEqual([
      "buffer_updated",
      "timeline_changed",
    ]);
  });

  it.each([
    {
      type: "buffer_added",
      buffer: directBufferUpdate({ unread: 1, mentions: 1 }).buffer,
    },
    {
      type: "buffers_changed",
      network_id: 1,
      buffers: [directBufferUpdate({ unread: 1, mentions: 1 }).buffer],
    },
    { type: "draft_key_changed", previous: "4:alice", current: "4:alicia" },
  ])("publishes $type to a hidden page without a frame", (event) => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    client.setVisibility("hidden");

    port.emit(event);

    expect(frames).toHaveLength(0);
    expect(publishedTypes(listener)).toEqual([event.type]);
  });

  it("drops a hidden buffer's held patches once it is removed", () => {
    const { client, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    client.setVisibility("hidden");

    port.emit(timelineChange(4, "ping while you are away"));
    port.emit(notice("kept"));
    port.emit({ type: "buffer_removed", buffer_id: 4 });
    client.setVisibility("visible");

    expect(publishedTypes(listener)).toEqual(["buffer_removed", "notice"]);
    expect(client.timeline(4)).toBeUndefined();
  });

  it("publishes a count still waiting for its frame when the page hides", () => {
    const { client, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    port.emit(directBufferUpdate({ unread: 0, mentions: 0 }));
    client.setVisibility("hidden");
    port.emit(directBufferUpdate({ unread: 1, mentions: 1 }));
    client.setVisibility("visible");

    expect(
      listener.mock.calls.map(([message]) => message.buffer.mentions),
    ).toEqual([0, 1]);
  });

  it("publishes queued buffer-list events at hide and keeps timeline patches queued", () => {
    const { client, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    port.emit(timelineChange(4, "arrived just before hiding"));
    port.emit(directBufferUpdate({ unread: 1, mentions: 1 }));
    port.emit({
      type: "draft_key_changed",
      previous: "4:alice",
      current: "4:alicia",
    });
    client.setVisibility("hidden");

    expect(publishedTypes(listener)).toEqual([
      "buffer_updated",
      "draft_key_changed",
    ]);

    client.setVisibility("visible");
    expect(publishedTypes(listener)).toEqual([
      "buffer_updated",
      "draft_key_changed",
      "timeline_changed",
    ]);
  });

  it("drops a removed buffer's queued patches when the page hides", () => {
    const { client, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);

    port.emit(timelineChange(4, "arrived just before hiding"));
    port.emit({ type: "buffer_removed", buffer_id: 4 });
    client.setVisibility("hidden");
    client.setVisibility("visible");

    expect(publishedTypes(listener)).toEqual(["buffer_removed"]);
  });

  it("flushes prior events before an optimistic row in the same frame", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const optimistic = {
      id: 1,
      author: "weblounge",
      text: "hello",
      kind: "text" as const,
      bot: false,
      authorship: "own" as const,
      nick_color_index: 0,
      highlighted: false,
      delivery: "optimistic" as const,
      local_send_id: 1,
      server_ids: [],
      server_time_ms: null,
      received_at_ms: 1,
    };

    port.emit(notice("already-queued"));
    const optimisticPatch = {
      type: "timeline_changed",
      buffer_id: 2,
      reset: false,
      upserted: [timelineMessage(optimistic)],
      removed: [],
    };
    const confirmedPatch = {
      ...optimisticPatch,
      upserted: [
        timelineMessage({
          ...optimistic,
          delivery: "confirmed",
          local_send_id: null,
        }),
      ],
    };
    port.emit(optimisticPatch);
    port.emit(confirmedPatch);

    expect(listener.mock.calls.map(([message]) => message.type)).toEqual([
      "notice",
      "timeline_changed",
    ]);

    frames[0]?.(0);
    expect(listener.mock.calls.map(([message]) => message.type)).toEqual([
      "notice",
      "timeline_changed",
      "timeline_changed",
    ]);
  });

  it("flushes a timeline patch carrying an optimistic row immediately", () => {
    const { client, frames, port } = fixture();
    const listener = vi.fn();
    client.subscribe(listener);
    const optimistic = {
      id: 1,
      author: "weblounge",
      text: "hello",
      kind: "text" as const,
      bot: false,
      authorship: "own" as const,
      nick_color_index: 0,
      highlighted: false,
      delivery: "optimistic" as const,
      local_send_id: 1,
      server_ids: [],
      server_time_ms: null,
      received_at_ms: 1,
    };

    port.emit(notice("already-queued"));
    port.emit({
      type: "timeline_changed",
      buffer_id: 2,
      reset: false,
      upserted: [
        {
          id: 1,
          order: [1, 1, 1],
          day: 1,
          content_version: 0,
          body: { family: "message", ...optimistic },
        },
      ],
      removed: [],
    });

    expect(listener.mock.calls.map(([message]) => message.type)).toEqual([
      "notice",
      "timeline_changed",
    ]);
    expect(client.timeline(2)?.items[0]?.body).toEqual({
      family: "message",
      ...optimistic,
    });
    expect(frames).toHaveLength(1);
  });

  it("closes only its worker connection and rejects later requests", async () => {
    const { client, close } = fixture();

    await client.close();

    expect(close).toHaveBeenCalledOnce();
    const result = client.send({
      id: "late",
      request: { type: "diagnostic", message: "late" },
    });
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toThrow("closed");
    const restarted = client.start({
      build_id: "build-1",
      client_id: "late-tab",
      last_revision: null,
      shell: "web",
    });
    expect(restarted).toBeInstanceOf(Promise);
    await expect(restarted).rejects.toThrow("closed");
  });
});

function publishedTypes(listener: ReturnType<typeof vi.fn>): string[] {
  return listener.mock.calls.map(([message]) => message.type);
}

function directBufferUpdate(counts: {
  readonly unread: number;
  readonly mentions: number;
}) {
  return {
    type: "buffer_updated",
    buffer: {
      id: 4,
      network_id: 1,
      sync_state: "synced",
      kind: "direct",
      title: "alice",
      draft_key: "5:Local:rfc1459:nick=alice",
      topic: null,
      ...counts,
    },
  };
}

function timelineChange(bufferId: number, text: string) {
  return {
    type: "timeline_changed",
    buffer_id: bufferId,
    reset: false,
    upserted: [
      timelineMessage({
        id: 12,
        author: "alice",
        text,
        kind: "text",
        bot: false,
        authorship: "other",
        nick_color_index: 3,
        highlighted: false,
        delivery: "received",
        local_send_id: null,
        server_ids: ["msg-12"],
        server_time_ms: 1_700_000_000_000,
        received_at_ms: 1_700_000_000_010,
      }),
    ],
    removed: [],
  };
}

function timelineGap(id: number, time: number) {
  return {
    id,
    order: [time, time, id],
    day: 1,
    content_version: 0,
    body: { family: "gap", from_ms: time, to_ms: time + 1 },
  };
}

function timelineMessage(message: {
  readonly id: number;
  readonly received_at_ms: number;
  readonly server_time_ms: number | null;
  readonly [key: string]: unknown;
}) {
  return {
    id: message.id,
    order: [
      message.server_time_ms ?? message.received_at_ms,
      message.received_at_ms,
      message.id,
    ],
    day: 1,
    content_version: 0,
    body: { family: "message", ...message },
  };
}

function timelineRun(id: number, time: number) {
  return {
    id,
    order: [time, time, id],
    day: 1,
    content_version: 0,
    body: {
      family: "system",
      time_ms: time,
      line: {
        type: "run",
        clauses: [
          {
            type: "joined",
            people: [{ nick: "mel", nick_color_index: 2, me: false }],
          },
        ],
      },
    },
  };
}
