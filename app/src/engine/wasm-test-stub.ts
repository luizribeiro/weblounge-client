export default async function initialize(): Promise<never> {
  throw new Error("tests must inject an engine loader");
}

export class WasmEngine {
  constructor() {
    throw new Error("tests must inject an engine loader");
  }

  handle(): never {
    throw new Error("tests must inject an engine loader");
  }
}
