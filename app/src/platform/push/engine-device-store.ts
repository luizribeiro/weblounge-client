import type { EngineClient } from "../../engine/EngineClient";
import type { PushDeviceCredentials } from "../../engine/generated/PushDeviceCredentials";
import { requestReply } from "../../engine/request-reply";

export interface PushDeviceStore {
  load(relay: string): Promise<PushDeviceCredentials | undefined>;
  store(credentials: PushDeviceCredentials): Promise<void>;
  clear(relay: string): Promise<void>;
}

export class EnginePushDeviceStore implements PushDeviceStore {
  constructor(private readonly engine: EngineClient) {}

  load(relay: string): Promise<PushDeviceCredentials | undefined> {
    return requestReply(
      this.engine,
      { type: "load_push_device", relay },
      (message, commandId) =>
        message.type === "push_device_loaded" &&
        message.command_id === commandId
          ? { value: message.credentials ?? undefined }
          : undefined,
    );
  }

  async store(credentials: PushDeviceCredentials): Promise<void> {
    await this.engine.send({
      id: crypto.randomUUID(),
      request: { type: "store_push_device", credentials },
    });
  }

  async clear(relay: string): Promise<void> {
    await this.engine.send({
      id: crypto.randomUUID(),
      request: { type: "clear_push_device", relay },
    });
  }
}
