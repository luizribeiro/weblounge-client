import { encodeBase64Url } from "./base64url";
import {
  openPushDatabase,
  pageDatabaseDeadlineMs,
  pushRouteIdIndex,
  pushRoutesStore,
  requestResult,
  transactionDone,
} from "./push-database";
import type { WebPushTarget } from "./subscription";

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
  readonly privateKeyPkcs8: Uint8Array<ArrayBuffer>;
  readonly target?: WebPushTarget;
  readonly active?: boolean;
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
  readonly privateKeyPkcs8: Uint8Array<ArrayBuffer>;
}

export async function createRouteKeys(
  webCrypto: Crypto = crypto,
): Promise<RouteKeys> {
  const pair = (await webCrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const [rawPublicKey, privateKeyPkcs8] = await Promise.all([
    webCrypto.subtle.exportKey("raw", pair.publicKey),
    webCrypto.subtle.exportKey("pkcs8", pair.privateKey),
  ]);
  const auth = new Uint8Array(16);
  webCrypto.getRandomValues(auth);
  return {
    p256dh: encodeBase64Url(rawPublicKey),
    auth: encodeBase64Url(auth),
    privateKeyPkcs8: new Uint8Array(privateKeyPkcs8),
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
      transaction.objectStore(pushRoutesStore).put(encodeRoute(route));
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
    typeof networkLabel !== "string" ||
    typeof nickname !== "string"
  ) {
    throw new Error("push database contains an invalid route");
  }
  const metadata = {
    networkId: value.networkId,
    networkLabel,
    nickname,
    vapid: value.vapid,
    routeId: value.routeId,
    endpoint: value.endpoint,
    p256dh: value.p256dh,
    auth: value.auth,
    ...("needsReregistration" in value && value.needsReregistration === true
      ? { needsReregistration: true }
      : {}),
    ...("deviceId" in value && typeof value.deviceId === "string"
      ? { deviceId: value.deviceId }
      : {}),
    ...("retiring" in value && value.retiring === true
      ? { retiring: true }
      : {}),
    ...("target" in value && isWebPushTarget(value.target)
      ? { target: value.target }
      : {}),
    ...("active" in value && value.active === true ? { active: true } : {}),
  };
  const privateKeyPkcs8 =
    "privateKeyPkcs8" in value
      ? decodePrivateKeyBytes(value.privateKeyPkcs8)
      : undefined;
  if (privateKeyPkcs8 !== undefined) {
    return { ...metadata, privateKeyPkcs8 };
  }
  throw new Error("push database contains an invalid route key");
}

function decodePrivateKeyBytes(
  value: unknown,
): Uint8Array<ArrayBuffer> | undefined {
  if (
    !ArrayBuffer.isView(value) ||
    value.constructor.name !== "Uint8Array" ||
    value.byteLength === 0
  ) {
    return undefined;
  }
  return Uint8Array.from(value as Uint8Array);
}

function encodeRoute(route: StoredPushRoute): StoredPushRoute {
  return {
    networkId: route.networkId,
    networkLabel: route.networkLabel,
    nickname: route.nickname,
    vapid: route.vapid,
    routeId: route.routeId,
    endpoint: route.endpoint,
    p256dh: route.p256dh,
    auth: route.auth,
    privateKeyPkcs8: route.privateKeyPkcs8.slice(),
    ...(route.deviceId === undefined ? {} : { deviceId: route.deviceId }),
    ...(route.target === undefined ? {} : { target: route.target }),
    ...(route.active === true ? { active: true } : {}),
    ...(route.needsReregistration === true
      ? { needsReregistration: true }
      : {}),
    ...(route.retiring === true ? { retiring: true } : {}),
  };
}

function isWebPushTarget(value: unknown): value is WebPushTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    "endpoint" in value &&
    typeof value.endpoint === "string" &&
    "p256dh" in value &&
    typeof value.p256dh === "string" &&
    "auth" in value &&
    typeof value.auth === "string"
  );
}
