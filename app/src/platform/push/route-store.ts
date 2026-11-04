import { encodeBase64Url } from "./base64url";
import {
  openPushDatabase,
  pushRoutesStore,
  requestResult,
  transactionDone,
} from "./push-database";

export interface StoredPushRoute {
  readonly networkId: number;
  readonly networkLabel: string;
  readonly nickname: string;
  readonly vapid: string;
  readonly routeId: string;
  readonly deviceId?: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly privateKey: CryptoKey;
  readonly needsReregistration?: boolean;
  readonly retiring?: boolean;
}

export interface PushRouteStore {
  get(routeId: string): Promise<StoredPushRoute | undefined>;
  put(route: StoredPushRoute): Promise<void>;
  delete(routeId: string): Promise<void>;
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

  async get(routeId: string): Promise<StoredPushRoute | undefined> {
    const database = await this.#database;
    const transaction = database.transaction(pushRoutesStore, "readonly");
    const value = await requestResult(
      transaction.objectStore(pushRoutesStore).get(routeId),
    );
    await transactionDone(transaction);
    return value === undefined ? undefined : decodeRoute(value);
  }

  async put(route: StoredPushRoute): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction(pushRoutesStore, "readwrite");
    transaction.objectStore(pushRoutesStore).put(route);
    await transactionDone(transaction);
  }

  async delete(routeId: string): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction(pushRoutesStore, "readwrite");
    transaction.objectStore(pushRoutesStore).delete(routeId);
    await transactionDone(transaction);
  }

  async all(): Promise<readonly StoredPushRoute[]> {
    const database = await this.#database;
    const transaction = database.transaction(pushRoutesStore, "readonly");
    const values = await requestResult(
      transaction.objectStore(pushRoutesStore).getAll(),
    );
    await transactionDone(transaction);
    return values.map(decodeRoute);
  }
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return openPushDatabase(factory);
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
    ...("deviceId" in value && typeof value.deviceId === "string"
      ? { deviceId: value.deviceId }
      : {}),
    ...("retiring" in value && value.retiring === true
      ? { retiring: true }
      : {}),
  };
}
