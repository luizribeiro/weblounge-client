/// <reference types="vite/client" />

declare const __BUILD_ID__: string;
declare const __DEBUG_IRC_CONFIG__: {
  endpoint: string;
  nickname: string;
  account: string;
  channel: string;
  allowInsecure: boolean;
} | null;

declare module "@weblounge-engine" {
  export default function initialize(module: string): Promise<unknown>;

  export class WasmEngine {
    handle(message: string): string;
  }

  export function create_wasm_engine(
    buildId: string,
    instanceId: string,
    onEvent: (encoded: string) => void,
  ): Promise<WasmEngine>;
}

declare module "@weblounge-engine-wasm" {
  const url: string;
  export default url;
}
