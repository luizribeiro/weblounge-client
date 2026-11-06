import { connectionPresentation } from "./connection-state";
import type { BufferProjection, NetworkProjection } from "./protocol";

export interface BufferSyncPresentation {
  readonly interrupted: boolean;
  readonly progressing: boolean;
}

export function bufferSyncPresentation(
  buffer: BufferProjection,
  network: NetworkProjection | undefined,
): BufferSyncPresentation {
  const connection = connectionPresentation(
    network === undefined ? [] : [network],
  );
  const interrupted = connection.error !== undefined;
  return {
    interrupted,
    progressing:
      !interrupted &&
      (connection.progressing || buffer.sync_state === "syncing"),
  };
}
