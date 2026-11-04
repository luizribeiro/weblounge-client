import {
  ENGINE_DATABASE_NAME,
  ENGINE_DATABASE_VERSION,
} from "./engine/generated/EngineDatabaseSchema";
import { routeNotificationClick } from "./platform/push/notification-routing";
import {
  decodePushBase64Url,
  decryptPushPayload,
} from "./platform/push/push-decryption";
import {
  bufferPath,
  genericNotification,
  isChatPayload,
  notificationForLine,
  type ParsedPushEvent,
  sameIrcName,
} from "./platform/push/push-notification";
import {
  PushParserLoader,
  type PushPayloadParser,
} from "./platform/push/push-parser-loader";

declare const SHELL_VERSION: string;
declare const PRECACHE_URLS: readonly string[];
declare const __PUSH_EVENT_HARNESS__: boolean;
declare const wasm_bindgen: PushPayloadParser &
  ((input: Response) => Promise<unknown>);

interface WorkerEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface WorkerPushEvent extends WorkerEvent {
  readonly data: { json(): unknown } | null;
}

interface PushPayloadEvent {
  readonly data: { json(): unknown } | null;
}

interface WorkerNotificationEvent extends WorkerEvent {
  readonly notification: Notification;
}

interface WorkerScope {
  readonly location: Location;
  readonly registration: ServiceWorkerRegistration;
  readonly clients: {
    claim(): Promise<void>;
    matchAll(options: {
      readonly type: "window";
      readonly includeUncontrolled: true;
    }): Promise<readonly WindowClient[]>;
    openWindow(url: string): Promise<WindowClient | null>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, listener: (event: Event) => void): void;
  importScripts(...urls: readonly string[]): void;
}

interface WindowClient {
  focus(): Promise<WindowClient>;
  postMessage(message: unknown): void;
}

interface StoredRoute {
  readonly networkId: number;
  readonly networkLabel: string;
  readonly nickname: string;
  readonly vapid: string;
  readonly routeId: string;
  readonly deviceId?: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly privateKey: CryptoKey;
  readonly needsReregistration?: boolean;
  readonly retiring?: boolean;
}

const worker = globalThis as unknown as WorkerScope;
const emergencyReloadParameter = "_weblounge_reload";
const shellCache = `weblounge-shell-${SHELL_VERSION}`;
const precachePaths = new Set(PRECACHE_URLS);
const precacheBatchSize = 2;
const navigationDeadlineMs = 2_500;
const pushNotificationDeadlineMs = 2_800;
const databaseDeadlineMs = 500;
const pushDatabaseName = "weblounge-push";
const pushDatabaseVersion = 4;
const pushRoutesStore = "routes";
const pushRouteIdIndex = "route-id";
const pushStateStore = "state";
const appBadgeKey = "app-badge";
const notificationCountsKey = "notification-counts";
const engineCacheStore = "cache";
const textEncoder = new TextEncoder();
const parser = new PushParserLoader(loadPushParser);
let pushQueue = Promise.resolve();
const harnessNotifications: Notification[] = [];

worker.importScripts("/push-payload.js");

worker.addEventListener("install", (event) => {
  (event as WorkerEvent).waitUntil(
    precacheShell().then(() => worker.skipWaiting()),
  );
});

worker.addEventListener("activate", (event) => {
  (event as WorkerEvent).waitUntil(activateWorker());
});

worker.addEventListener("message", (event) => {
  const message = event as WorkerEvent & MessageEvent;
  const data: unknown = message.data;
  if (__PUSH_EVENT_HARNESS__ && isHarnessPush(data)) {
    const handled = queuePush({
      data: { json: () => JSON.parse(data.payload) },
    });
    message.waitUntil(
      handled.then(
        () =>
          message.source?.postMessage({
            type: "push_dispatched",
            id: data.id,
            notifications: harnessNotificationSnapshots(),
          }),
        (error: unknown) =>
          message.source?.postMessage({
            type: "push_dispatch_failed",
            id: data.id,
            error: pushError(error),
          }),
      ),
    );
    return;
  }
  if (!requestsActivation(data)) return;
  message.waitUntil(worker.skipWaiting());
});

worker.addEventListener("fetch", (event) => {
  const fetchEvent = event as Event & {
    readonly request: Request;
    respondWith(response: Promise<Response>): void;
  };
  const { request } = fetchEvent;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin || url.pathname === "/config.json")
    return;
  if (request.mode === "navigate") {
    fetchEvent.respondWith(
      url.searchParams.has(emergencyReloadParameter)
        ? fetch(request, { cache: "reload" })
        : navigationResponse(request),
    );
  } else if (precachePaths.has(url.pathname)) {
    fetchEvent.respondWith(shellResponse(url.pathname, request));
  } else if (url.pathname.startsWith("/assets/")) {
    fetchEvent.respondWith(previousShellAssetResponse(request));
  }
});

worker.addEventListener("push", (event) => {
  const pushEvent = event as WorkerPushEvent;
  pushEvent.waitUntil(queuePush(pushEvent));
});

worker.addEventListener("pushsubscriptionchange", (event) => {
  (event as WorkerEvent).waitUntil(notifyWindowsOfSubscriptionChange());
});

worker.addEventListener("notificationclick", (event) => {
  const click = event as WorkerNotificationEvent;
  click.waitUntil(routeNotificationClick(worker.clients, click.notification));
});

async function precacheShell(): Promise<void> {
  const cache = await caches.open(shellCache);
  const requests = PRECACHE_URLS.map(
    (url) =>
      new Request(url, {
        priority: "low",
      } as RequestInit & { priority: "low" }),
  );
  for (let offset = 0; offset < requests.length; offset += precacheBatchSize) {
    await cache.addAll(requests.slice(offset, offset + precacheBatchSize));
  }
}

async function activateWorker(): Promise<void> {
  const names = await caches.keys();
  const olderShells = names.filter(
    (name) => name.startsWith("weblounge-shell-") && name !== shellCache,
  );
  const previousShell = olderShells.at(-1);
  await Promise.all(
    olderShells
      .filter((name) => name !== previousShell)
      .map((name) => caches.delete(name)),
  );
  await worker.clients.claim();
}

function requestsActivation(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "skip_waiting"
  );
}

function isHarnessPush(value: unknown): value is {
  readonly type: "deliver_push";
  readonly id: string;
  readonly payload: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "deliver_push" &&
    "id" in value &&
    typeof value.id === "string" &&
    "payload" in value &&
    typeof value.payload === "string"
  );
}

function queuePush(pushEvent: PushPayloadEvent): Promise<void> {
  const handled = pushQueue.then(() => showPushNotification(pushEvent));
  pushQueue = handled.catch(() => undefined);
  return handled;
}

function pushError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return `${error.name}: ${error.message}${error.stack === undefined ? "" : `\n${error.stack}`}`;
}

async function navigationResponse(request: Request): Promise<Response> {
  const network = fetch(request);
  const fallback = caches.match("/index.html", { cacheName: shellCache });
  const deadline = new Promise<Response>((resolve, reject) => {
    setTimeout(() => {
      void fallback.then((cached) => {
        if (cached === undefined) void network.then(resolve, reject);
        else resolve(cached);
      });
    }, navigationDeadlineMs);
  });
  return Promise.race([
    network.catch(async (error: unknown) => {
      const cached = await fallback;
      if (cached !== undefined) return cached;
      throw error;
    }),
    deadline,
  ]);
}

async function shellResponse(
  cacheKey: string,
  request: Request,
): Promise<Response> {
  const cached = await caches.match(cacheKey, { cacheName: shellCache });
  return cached ?? fetch(request);
}

async function previousShellAssetResponse(request: Request): Promise<Response> {
  const cached = await caches.match(request);
  return cached ?? fetch(request);
}

interface PushPresentationState {
  expired: boolean;
  shown: boolean;
  showing: Promise<void> | undefined;
  generic: ReturnType<typeof genericNotification>;
}

async function showPushNotification(event: PushPayloadEvent): Promise<void> {
  const state: PushPresentationState = {
    expired: false,
    shown: false,
    showing: undefined,
    generic: genericNotification(),
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const fallback = new Promise<void>((resolve) => {
    deadline = setTimeout(() => {
      state.expired = true;
      void showOnce(state, state.generic).finally(resolve);
    }, pushNotificationDeadlineMs);
  });
  const detailed = preparePushNotification(event, state).catch(() =>
    showOnce(state, state.generic),
  );
  await Promise.race([detailed, fallback]);
  if (deadline !== undefined) clearTimeout(deadline);
  if (state.expired) {
    // wait-ok: bounded drain keeps timed-out storage work serialized.
    await Promise.race([
      detailed,
      new Promise<void>((resolve) =>
        setTimeout(resolve, databaseDeadlineMs + 50),
      ),
    ]);
  }
}

async function preparePushNotification(
  event: PushPayloadEvent,
  state: PushPresentationState,
): Promise<void> {
  const envelope = pushEnvelope(event.data?.json());
  const route = await findRoute(envelope.routeId);
  if (route === undefined) throw new Error("push route is unavailable");
  state.generic = genericNotification(route.networkLabel);
  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    plaintext = await decryptPushPayload(
      decodePushBase64Url(envelope.ciphertext),
      route.privateKey,
      route.p256dh,
      route.auth,
    );
  } catch (error: unknown) {
    if (!state.expired)
      await markForReregistration(route.routeId).catch(() => undefined);
    throw error;
  }
  const parsed = await notificationForLine(
    route,
    new TextDecoder().decode(plaintext),
    parser,
  );
  if (state.expired) return;
  if (parsed.event?.type === "markread") {
    await markConversationRead(
      conversationTag(route, parsed.event.target),
      parsed.event.until,
    ).catch(() => undefined);
    await tidyReadNotifications(false).catch(() => undefined);
    return;
  }
  if (parsed.event?.type === "ping") {
    await tidyReadNotifications().catch(() => undefined);
    return;
  }
  if (state.expired) return;
  await showOnce(state, parsed.presentation);
  let recordNotification = true;
  if (parsed.event !== undefined && isChatPayload(parsed.event)) {
    recordNotification = await storePushedMessage(route, parsed.event).catch(
      () => true,
    );
  }
  if (recordNotification && !state.expired) {
    await recordShownNotification(parsed.presentation.options.tag).catch(
      () => undefined,
    );
  }
}

async function showOnce(
  state: PushPresentationState,
  presentation: ReturnType<typeof genericNotification>,
): Promise<void> {
  if (state.shown) return;
  if (state.showing !== undefined) return state.showing;
  const attempt = showRegistrationNotification(
    presentation.title,
    presentation.options,
  );
  state.showing = attempt;
  try {
    await attempt;
    state.shown = true;
  } finally {
    state.showing = undefined;
  }
}

async function notifyWindowsOfSubscriptionChange(): Promise<void> {
  const clients = await worker.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of clients) {
    client.postMessage({ type: "push_subscription_change" });
  }
}

interface NotificationCounts {
  readonly conversations: Map<string, number>;
  readonly readAtMs: Map<string, number>;
  untagged: number;
}

async function recordShownNotification(tag: string | undefined): Promise<void> {
  await updateNotificationCounts((counts) => {
    if (tag === undefined || tag.length === 0) {
      counts.untagged += 1;
      return;
    }
    counts.conversations.set(tag, (counts.conversations.get(tag) ?? 0) + 1);
  });
}

async function markConversationRead(tag: string, until: string): Promise<void> {
  await updateNotificationCounts((counts) => {
    counts.conversations.set(tag, 0);
    const marker = readMarkerMillis(until);
    if (marker !== undefined) {
      counts.readAtMs.set(tag, Math.max(counts.readAtMs.get(tag) ?? 0, marker));
    }
  });
}

async function updateNotificationCounts(
  update: (counts: NotificationCounts) => void,
): Promise<void> {
  const database = await openPushDatabase();
  let total = 0;
  try {
    const transaction = database.transaction(pushStateStore, "readwrite");
    const completed = transactionDone(transaction);
    const store = transaction.objectStore(pushStateStore);
    const counts = decodeNotificationCounts(
      await requestResult(store.get(notificationCountsKey)),
    );
    update(counts);
    total = notificationCountTotal(counts);
    store.put(encodeNotificationCounts(counts), notificationCountsKey);
    store.put(total, appBadgeKey);
    await completed;
  } finally {
    database.close();
  }
  await setWorkerBadge(total);
}

async function tidyReadNotifications(recomputeBadge = true): Promise<void> {
  const database = await openPushDatabase();
  let counts: NotificationCounts;
  try {
    const transaction = database.transaction(pushStateStore, "readonly");
    const completed = transactionDone(transaction);
    counts = decodeNotificationCounts(
      await requestResult(
        transaction.objectStore(pushStateStore).get(notificationCountsKey),
      ),
    );
    await completed;
  } finally {
    database.close();
  }
  const readMarkers = new Map(counts.readAtMs);
  const notifications = await registrationNotifications();
  for (const notification of notifications) {
    if (notificationIsRead(notification, readMarkers)) notification.close();
  }
  if (recomputeBadge) await setWorkerBadge(notificationCountTotal(counts));
}

function showRegistrationNotification(
  title: string,
  options: NotificationOptions,
): Promise<void> {
  if (!__PUSH_EVENT_HARNESS__) {
    return worker.registration.showNotification(title, options);
  }
  const tag = options.tag ?? "";
  if (tag.length > 0) {
    for (const notification of [...harnessNotifications]) {
      if (notification.tag === tag) notification.close();
    }
  }
  const notification = {
    body: options.body ?? "",
    data: options.data,
    tag,
    title,
    close: () => {
      const index = harnessNotifications.indexOf(notification as Notification);
      if (index >= 0) harnessNotifications.splice(index, 1);
    },
  } as Notification;
  harnessNotifications.push(notification);
  return Promise.resolve();
}

function registrationNotifications(): Promise<Notification[]> {
  return __PUSH_EVENT_HARNESS__
    ? Promise.resolve([...harnessNotifications])
    : worker.registration.getNotifications();
}

function harnessNotificationSnapshots(): readonly unknown[] {
  return harnessNotifications.map(({ body, data, tag, title }) => ({
    body,
    data,
    tag,
    title,
  }));
}

function decodeNotificationCounts(value: unknown): NotificationCounts {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema" in value) ||
    (value.schema !== 1 && value.schema !== 2) ||
    !("conversations" in value) ||
    !Array.isArray(value.conversations) ||
    !("untagged" in value) ||
    !validCount(value.untagged)
  ) {
    return emptyNotificationCounts();
  }
  const conversations = new Map<string, number>();
  const readAtMs = new Map<string, number>();
  for (const entry of value.conversations) {
    if (value.schema === 1) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !validCount(entry[1])
      ) {
        return emptyNotificationCounts();
      }
      conversations.set(entry[0], entry[1]);
      continue;
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("tag" in entry) ||
      typeof entry.tag !== "string" ||
      !("count" in entry) ||
      !validCount(entry.count) ||
      !("read_at_ms" in entry) ||
      (entry.read_at_ms !== null && !validReadMarker(entry.read_at_ms))
    ) {
      return emptyNotificationCounts();
    }
    conversations.set(entry.tag, entry.count);
    if (entry.read_at_ms !== null) readAtMs.set(entry.tag, entry.read_at_ms);
  }
  return { conversations, readAtMs, untagged: value.untagged };
}

function encodeNotificationCounts(counts: NotificationCounts): unknown {
  return {
    schema: 2,
    conversations: [...counts.conversations].map(([tag, count]) => ({
      tag,
      count,
      read_at_ms: counts.readAtMs.get(tag) ?? null,
    })),
    untagged: counts.untagged,
  };
}

function emptyNotificationCounts(): NotificationCounts {
  return { conversations: new Map(), readAtMs: new Map(), untagged: 0 };
}

function notificationIsRead(
  notification: Notification,
  readMarkers: ReadonlyMap<string, number>,
): boolean {
  const data: unknown = notification.data;
  if (typeof data !== "object" || data === null) return false;
  if (
    !("conversationTag" in data) ||
    typeof data.conversationTag !== "string" ||
    !("messageTime" in data) ||
    typeof data.messageTime !== "string"
  )
    return false;
  const marker = readMarkers.get(data.conversationTag);
  const messageTime = Date.parse(data.messageTime);
  return (
    marker !== undefined && !Number.isNaN(messageTime) && messageTime <= marker
  );
}

function readMarkerMillis(reference: string): number | undefined {
  const timestamp = reference.startsWith("timestamp=")
    ? reference.slice("timestamp=".length)
    : reference;
  const marker = Date.parse(timestamp);
  return Number.isNaN(marker) ? undefined : marker;
}

function notificationCountTotal(counts: NotificationCounts): number {
  return (
    counts.untagged +
    [...counts.conversations.values()].reduce(
      (total, count) => total + count,
      0,
    )
  );
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validReadMarker(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function setWorkerBadge(count: number): Promise<void> {
  const badgeNavigator = globalThis.navigator as Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (count === 0) await badgeNavigator.clearAppBadge?.();
  else await badgeNavigator.setAppBadge?.(count);
}

function conversationTag(route: StoredRoute, target: string): string {
  return `${route.networkLabel}/${target.toLowerCase()}`;
}
async function loadPushParser(): Promise<PushPayloadParser> {
  const response = await caches.match("/push-payload_bg.wasm", {
    cacheName: shellCache,
  });
  if (response === undefined) throw new Error("push parser is not cached");
  await wasm_bindgen(response);
  return wasm_bindgen;
}

function pushEnvelope(value: unknown): {
  readonly routeId: string;
  readonly ciphertext: string;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("notification" in value) ||
    typeof value.notification !== "object" ||
    value.notification === null ||
    !("data" in value.notification) ||
    typeof value.notification.data !== "object" ||
    value.notification.data === null ||
    !("r" in value.notification.data) ||
    typeof value.notification.data.r !== "string" ||
    !("c" in value.notification.data) ||
    typeof value.notification.data.c !== "string"
  ) {
    throw new Error("invalid declarative push envelope");
  }
  return {
    routeId: value.notification.data.r,
    ciphertext: value.notification.data.c,
  };
}

async function findRoute(routeId: string): Promise<StoredRoute | undefined> {
  const database = await openPushDatabase();
  try {
    const transaction = database.transaction(pushRoutesStore, "readonly");
    const route = await requestResult(
      transaction
        .objectStore(pushRoutesStore)
        .index(pushRouteIdIndex)
        .get(routeId),
    );
    await transactionDone(transaction);
    return route === undefined ? undefined : decodeStoredRoute(route);
  } finally {
    database.close();
  }
}

async function markForReregistration(routeId: string): Promise<void> {
  const database = await openPushDatabase();
  try {
    const transaction = database.transaction(pushRoutesStore, "readwrite");
    const store = transaction.objectStore(pushRoutesStore);
    const current = await requestResult(
      store.index(pushRouteIdIndex).get(routeId),
    );
    if (current !== undefined) {
      store.put({ ...decodeStoredRoute(current), needsReregistration: true });
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

async function storePushedMessage(
  route: StoredRoute,
  message: Extract<ParsedPushEvent, { type: "message" | "notice" | "action" }>,
): Promise<boolean> {
  const direct = sameIrcName(message.target, route.nickname);
  const record = {
    schema: 1,
    network_label: route.networkLabel,
    nickname: route.nickname,
    route: bufferPath(
      route.networkLabel,
      direct ? message.sender : message.target,
      direct,
    ),
    sender: message.sender,
    account: message.account,
    target: message.target,
    msgid: message.msgid,
    time: message.time,
    text: message.text,
    kind: message.type,
  };
  const database = await openCurrentEngineDatabase();
  try {
    if (!database.objectStoreNames.contains(engineCacheStore)) return true;
    const transaction = database.transaction(engineCacheStore, "readwrite");
    const completed = transactionDone(transaction);
    const store = transaction.objectStore(engineCacheStore);
    const key = textEncoder.encode(
      `pushed-message\0${route.networkLabel}\0${message.msgid}`,
    );
    const value = textEncoder.encode(JSON.stringify(record));
    const existing = await requestResult(store.get(key));
    store.put(value, key);
    await completed;
    return existing === undefined;
  } finally {
    database.close();
  }
}

function decodeStoredRoute(value: unknown): StoredRoute {
  if (
    typeof value !== "object" ||
    value === null ||
    !("networkId" in value) ||
    typeof value.networkId !== "number" ||
    !("networkLabel" in value) ||
    typeof value.networkLabel !== "string" ||
    !("nickname" in value) ||
    typeof value.nickname !== "string" ||
    !("vapid" in value) ||
    typeof value.vapid !== "string" ||
    !("routeId" in value) ||
    typeof value.routeId !== "string" ||
    !("p256dh" in value) ||
    typeof value.p256dh !== "string" ||
    !("auth" in value) ||
    typeof value.auth !== "string" ||
    !("privateKey" in value) ||
    !(value.privateKey instanceof CryptoKey)
  ) {
    throw new Error("invalid stored push route");
  }
  return value as unknown as StoredRoute;
}

function openCurrentEngineDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(
      ENGINE_DATABASE_NAME,
      ENGINE_DATABASE_VERSION,
    );
    const deadline = setTimeout(() => {
      settled = true;
      reject(new Error("engine database open timed out"));
    }, databaseDeadlineMs);
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => {
      const database = request.result;
      clearTimeout(deadline);
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onblocked = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(new Error("engine database open was blocked"));
    };
    request.onerror = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("engine database failed to open"));
    };
  });
}

function openPushDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(pushDatabaseName, pushDatabaseVersion);
    const deadline = setTimeout(() => {
      settled = true;
      reject(new Error("push database open timed out"));
    }, databaseDeadlineMs);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(pushRoutesStore)) {
        createRoutesStore(request.result);
      } else if (
        request.transaction?.objectStore(pushRoutesStore).keyPath !== "vapid"
      ) {
        const transaction = request.transaction;
        if (transaction === null)
          throw new Error("missing upgrade transaction");
        migrateRoutesToHomes(request.result, transaction);
      } else {
        const routes = request.transaction?.objectStore(pushRoutesStore);
        if (
          routes !== undefined &&
          !routes.indexNames.contains(pushRouteIdIndex)
        ) {
          routes.createIndex(pushRouteIdIndex, "routeId", { unique: true });
        }
      }
      if (!request.result.objectStoreNames.contains(pushStateStore)) {
        request.result.createObjectStore(pushStateStore);
      }
    };
    request.onsuccess = () => {
      clearTimeout(deadline);
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onblocked = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(new Error("push database open was blocked"));
    };
    request.onerror = () => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("push database failed to open"));
    };
  });
}

function migrateRoutesToHomes(
  database: IDBDatabase,
  transaction: IDBTransaction,
): void {
  const routes = transaction.objectStore(pushRoutesStore).getAll();
  routes.onsuccess = () => {
    database.deleteObjectStore(pushRoutesStore);
    const store = createRoutesStore(database);
    const selected = new Map<string, unknown>();
    for (const route of routes.result) {
      if (!isStoredHomeRoute(route)) continue;
      const current = selected.get(route.vapid);
      if (current === undefined || preferRoute(route, current)) {
        selected.set(route.vapid, route);
      }
    }
    for (const route of selected.values()) store.put(route);
  };
}

function createRoutesStore(database: IDBDatabase): IDBObjectStore {
  const store = database.createObjectStore(pushRoutesStore, {
    keyPath: "vapid",
  });
  store.createIndex(pushRouteIdIndex, "routeId", { unique: true });
  return store;
}

function isStoredHomeRoute(value: unknown): value is Record<string, unknown> & {
  vapid: string;
  routeId: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "vapid" in value &&
    typeof value.vapid === "string" &&
    "routeId" in value &&
    typeof value.routeId === "string"
  );
}

function preferRoute(candidate: unknown, current: unknown): boolean {
  if (!isStoredHomeRoute(candidate) || !isStoredHomeRoute(current))
    return false;
  const candidateComplete =
    typeof candidate.deviceId === "string" &&
    typeof candidate.networkLabel === "string" &&
    candidate.networkLabel.length > 0;
  const currentComplete =
    typeof current.deviceId === "string" &&
    typeof current.networkLabel === "string" &&
    current.networkLabel.length > 0;
  return candidateComplete === currentComplete
    ? candidate.routeId.localeCompare(current.routeId) < 0
    : candidateComplete;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("push database request timed out")),
      databaseDeadlineMs,
    );
    request.onsuccess = () => {
      clearTimeout(deadline);
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(deadline);
      reject(request.error ?? new Error("push database request failed"));
    };
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      try {
        transaction.abort();
      } catch {}
      reject(new Error("push database transaction timed out"));
    }, databaseDeadlineMs);
    transaction.oncomplete = () => {
      clearTimeout(deadline);
      resolve();
    };
    transaction.onabort = () => {
      clearTimeout(deadline);
      reject(
        transaction.error ?? new Error("push database transaction aborted"),
      );
    };
    transaction.onerror = () => {
      clearTimeout(deadline);
      reject(
        transaction.error ?? new Error("push database transaction failed"),
      );
    };
  });
}
