import { encodeBase64Url } from "./base64url";
import {
  openPushDatabase,
  pageDatabaseDeadlineMs,
  pushRouteIdIndex,
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
  get(homeVapid: string): Promise<StoredPushRoute | undefined>;
  findRoute(routeId: string): Promise<StoredPushRoute | undefined>;
  put(route: StoredPushRoute): Promise<void>;
  delete(homeVapid: string): Promise<void>;
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
  readonly #factory: IDBFactory;

  constructor(factory: IDBFactory = indexedDB) {
    this.#factory = factory;
  }

  async get(homeVapid: string): Promise<StoredPushRoute | undefined> {
    const database = await openDatabase(this.#factory);
    try {
      const transaction = database.transaction(pushRoutesStore, "readonly");
      const value = await requestResult(
        transaction.objectStore(pushRoutesStore).get(homeVapid),
        pageDatabaseDeadlineMs,
      );
      await transactionDone(transaction, pageDatabaseDeadlineMs);
      return value === undefined ? undefined : decodeRoute(value);
    } finally {
      database.close();
    }
  }

  async findRoute(routeId: string): Promise<StoredPushRoute | undefined> {
    const database = await openDatabase(this.#factory);
    try {
      const transaction = database.transaction(pushRoutesStore, "readonly");
      const value = await requestResult(
        transaction
          .objectStore(pushRoutesStore)
          .index(pushRouteIdIndex)
          .get(routeId),
        pageDatabaseDeadlineMs,
      );
      await transactionDone(transaction, pageDatabaseDeadlineMs);
      return value === undefined ? undefined : decodeRoute(value);
    } finally {
      database.close();
    }
  }

  async put(route: StoredPushRoute): Promise<void> {
    const database = await openDatabase(this.#factory);
    try {
      const transaction = database.transaction(pushRoutesStore, "readwrite");
      transaction.objectStore(pushRoutesStore).put(route);
      await transactionDone(transaction, pageDatabaseDeadlineMs);
    } finally {
      database.close();
    }
  }

  async delete(homeVapid: string): Promise<void> {
    const database = await openDatabase(this.#factory);
    try {
      const transaction = database.transaction(pushRoutesStore, "readwrite");
      transaction.objectStore(pushRoutesStore).delete(homeVapid);
      await transactionDone(transaction, pageDatabaseDeadlineMs);
    } finally {
      database.close();
    }
  }

  async all(): Promise<readonly StoredPushRoute[]> {
    const database = await openDatabase(this.#factory);
    try {
      const transaction = database.transaction(pushRoutesStore, "readonly");
      const values = await requestResult(
        transaction.objectStore(pushRoutesStore).getAll(),
        pageDatabaseDeadlineMs,
      );
      await transactionDone(transaction, pageDatabaseDeadlineMs);
      return values.map(decodeRoute);
    } finally {
      database.close();
    }
  }
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return openPushDatabase(factory, pageDatabaseDeadlineMs);
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
