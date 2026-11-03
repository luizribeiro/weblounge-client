import type { EngineClient } from "../../engine/EngineClient";
import type { PushDeviceCredentials } from "../../engine/generated/PushDeviceCredentials";

export interface PushDeviceStore {
  load(relay: string): Promise<PushDeviceCredentials | undefined>;
  store(credentials: PushDeviceCredentials): Promise<void>;
  clear(relay: string): Promise<void>;
}

export class EnginePushDeviceStore implements PushDeviceStore {
  constructor(private readonly engine: EngineClient) {}

  load(relay: string): Promise<PushDeviceCredentials | undefined> {
    const commandId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const unsubscribe = this.engine.subscribe((message) => {
        if (
          message.type === "push_device_loaded" &&
          message.command_id === commandId
        ) {
          unsubscribe();
          resolve(message.credentials ?? undefined);
        }
      });
      void this.engine
        .send({
          id: commandId,
          request: { type: "load_push_device", relay },
        })
        .catch((error: unknown) => {
          unsubscribe();
          reject(error);
        });
    });
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
