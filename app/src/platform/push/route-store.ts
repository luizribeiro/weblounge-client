import { encodeBase64Url } from "./base64url";

const databaseName = "weblounge-push";
const routesStore = "routes";

export interface StoredPushRoute {
  readonly networkId: number;
  readonly networkLabel: string;
  readonly nickname: string;
  readonly vapid: string;
  readonly routeId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly privateKey: CryptoKey;
  readonly needsReregistration?: boolean;
}

export interface PushRouteStore {
  get(networkId: number): Promise<StoredPushRoute | undefined>;
  put(route: StoredPushRoute): Promise<void>;
  delete(networkId: number): Promise<void>;
  all(): Promise<readonly StoredPushRoute[]>;
}

export interface RouteKeys {
  readonly p256dh: string;
  readonly auth: string;
  readonly privateKey: CryptoKey;
}

export async function createRouteKeys(
  webCrypto: Crypto = crypto,
): Promise<RouteKeys> {
  const pair = (await webCrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  )) as CryptoKeyPair;
  if (pair.privateKey.extractable) {
    throw new Error("route private key must be non-extractable");
  }
  const rawPublicKey = await webCrypto.subtle.exportKey("raw", pair.publicKey);
  const auth = new Uint8Array(16);
  webCrypto.getRandomValues(auth);
  return {
    p256dh: encodeBase64Url(rawPublicKey),
    auth: encodeBase64Url(auth),
    privateKey: pair.privateKey,
  };
}

export class IndexedDbPushRouteStore implements PushRouteStore {
  readonly #database: Promise<IDBDatabase>;

  constructor(factory: IDBFactory = indexedDB) {
    this.#database = openDatabase(factory);
  }

  async get(networkId: number): Promise<StoredPushRoute | undefined> {
    const database = await this.#database;
    const transaction = database.transaction(routesStore, "readonly");
    const value = await requestResult(
      transaction.objectStore(routesStore).get(networkId),
    );
    await transactionDone(transaction);
    return value === undefined ? undefined : decodeRoute(value);
  }

  async put(route: StoredPushRoute): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction(routesStore, "readwrite");
    transaction.objectStore(routesStore).put(route);
    await transactionDone(transaction);
  }

  async delete(networkId: number): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction(routesStore, "readwrite");
    transaction.objectStore(routesStore).delete(networkId);
    await transactionDone(transaction);
  }

  async all(): Promise<readonly StoredPushRoute[]> {
    const database = await this.#database;
    const transaction = database.transaction(routesStore, "readonly");
    const values = await requestResult(
      transaction.objectStore(routesStore).getAll(),
    );
    await transactionDone(transaction);
    return values.map(decodeRoute);
  }
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(routesStore)) {
        request.result.createObjectStore(routesStore, { keyPath: "networkId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("push database failed to open"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("push database request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("push database transaction aborted"),
      );
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("push database transaction failed"),
      );
  });
}

function decodeRoute(value: unknown): StoredPushRoute {
  const networkLabel =
    typeof value === "object" && value !== null && "networkLabel" in value
      ? value.networkLabel
      : "";
  const nickname =
    typeof value === "object" && value !== null && "nickname" in value
      ? value.nickname
      : "";
  if (
    typeof value !== "object" ||
    value === null ||
    !("networkId" in value) ||
    typeof value.networkId !== "number" ||
    !("vapid" in value) ||
    typeof value.vapid !== "string" ||
    !("routeId" in value) ||
    typeof value.routeId !== "string" ||
    !("endpoint" in value) ||
    typeof value.endpoint !== "string" ||
    !("p256dh" in value) ||
    typeof value.p256dh !== "string" ||
    !("auth" in value) ||
    typeof value.auth !== "string" ||
    !("privateKey" in value) ||
    !(value.privateKey instanceof CryptoKey) ||
    typeof networkLabel !== "string" ||
    typeof nickname !== "string"
  ) {
    throw new Error("push database contains an invalid route");
  }
  return {
    ...(value as Omit<StoredPushRoute, "networkLabel" | "nickname">),
    networkLabel,
    nickname,
    ...("needsReregistration" in value && value.needsReregistration === true
      ? { needsReregistration: true }
      : {}),
  };
}
