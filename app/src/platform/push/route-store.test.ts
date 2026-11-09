import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { decodeBase64Url } from "./base64url";
import {
  pushDatabaseName,
  pushRoutesStore,
  transactionDone,
} from "./push-database";
import {
  createRouteKeys,
  IndexedDbPushRouteStore,
  type StoredPushRoute,
} from "./route-store";

it("creates exportable route bytes without retaining a CryptoKey", async () => {
  const keys = await createRouteKeys(webcrypto as unknown as Crypto);

  expect(decodeBase64Url(keys.p256dh)).toHaveLength(65);
  expect(decodeBase64Url(keys.auth)).toHaveLength(16);
  expect(keys.privateKeyPkcs8).toBeInstanceOf(Uint8Array);
  expect(containsCryptoKey(keys)).toBe(false);
});

it("stores no CryptoKey anywhere in a route record", async () => {
  const factory = new IDBFactory();
  const store = new IndexedDbPushRouteStore(factory);
  const keys = await createRouteKeys(webcrypto as unknown as Crypto);

  await store.put(route(keys));

  expect(containsCryptoKey(await readRawRoute(factory))).toBe(false);
});

it("detects a legacy CryptoKey route without returning its key", async () => {
  const factory = new IDBFactory();
  const pair = (await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  )) as import("node:crypto").webcrypto.CryptoKeyPair;
  const store = new IndexedDbPushRouteStore(factory);
  await store.get("missing");
  await seedRawRoute(
    factory,
    route({
      privateKey: pair.privateKey as unknown as CryptoKey,
    }),
  );

  const stored = await store.get("home-vapid");

  expect(stored).toMatchObject({ keyStorage: "legacy-crypto-key" });
  expect(containsCryptoKey(stored)).toBe(false);
  expect(containsCryptoKey(await readRawRoute(factory))).toBe(false);
});

function route(keys: object): StoredPushRoute {
  return {
    networkId: 1,
    networkLabel: "Lounge",
    nickname: "weblounge",
    vapid: "home-vapid",
    routeId: "route-1",
    deviceId: "device-1",
    endpoint: "https://push.example.test/v1/r/route-1",
    p256dh: "route-public-key",
    auth: "route-auth",
    ...keys,
  } as StoredPushRoute;
}

async function seedRawRoute(factory: IDBFactory, value: object): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(pushDatabaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction(pushRoutesStore, "readwrite");
  transaction.objectStore(pushRoutesStore).put(value);
  await transactionDone(transaction);
  database.close();
}

async function readRawRoute(factory: IDBFactory): Promise<unknown> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(pushDatabaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction(pushRoutesStore, "readonly");
  const value = await new Promise<unknown>((resolve, reject) => {
    const request = transaction.objectStore(pushRoutesStore).get("home-vapid");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await transactionDone(transaction);
  database.close();
  return value;
}

function containsCryptoKey(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (value.constructor.name === "CryptoKey") return true;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const child of Object.values(value)) {
    if (containsCryptoKey(child, seen)) return true;
  }
  return false;
}
