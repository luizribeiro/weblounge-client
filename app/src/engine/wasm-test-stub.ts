export default async function initialize(_input: {
  module_or_path: string;
}): Promise<never> {
  throw new Error("tests must inject an engine loader");
}

export class WasmEngine {
  handle(): never {
    throw new Error("tests must inject an engine loader");
  }
}

export async function create_wasm_engine(): Promise<WasmEngine> {
  throw new Error("tests must inject an engine loader");
}
