import { routeNotificationClick } from "./platform/push/notification-routing";
import {
  decodePushBase64Url,
  decryptPushPayload,
} from "./platform/push/push-decryption";

declare const SHELL_VERSION: string;
declare const PRECACHE_URLS: readonly string[];
declare const wasm_bindgen: PushPayloadParser &
  ((input: Response) => Promise<unknown>);

interface PushPayloadParser {
  parse_push_payload_json(input: string): string;
}

interface WorkerEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface WorkerPushEvent extends WorkerEvent {
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
  readonly routeId: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly privateKey: CryptoKey;
  readonly needsReregistration?: boolean;
}

type ParsedPushEvent =
  | ({ readonly type: "message" | "notice" | "action" } & ChatPayload)
  | {
      readonly type: "invite";
      readonly sender: string;
      readonly target: string;
    }
  | {
      readonly type: "markread";
      readonly target: string;
      readonly until: string;
    }
  | { readonly type: "ping" };

interface ChatPayload {
  readonly sender: string;
  readonly target: string;
  readonly msgid: string;
  readonly time: string;
  readonly text: string;
}

interface NotificationPresentation {
  readonly title: string;
  readonly options: NotificationOptions;
}

const worker = globalThis as unknown as WorkerScope;
const shellCache = `weblounge-shell-${SHELL_VERSION}`;
const precachePaths = new Set(PRECACHE_URLS);
const precacheBatchSize = 2;
const pushDatabase = "weblounge-push";
const routesStore = "routes";
const engineDatabase = "weblounge";
const engineCacheStore = "cache";
const textEncoder = new TextEncoder();
let parserReady: Promise<PushPayloadParser> | undefined;

worker.importScripts("/push-payload.js");

worker.addEventListener("install", (event) => {
  (event as WorkerEvent).waitUntil(precacheShell());
});

worker.addEventListener("activate", (event) => {
  (event as WorkerEvent).waitUntil(activateWorker());
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
    fetchEvent.respondWith(shellResponse("/index.html", request));
  } else if (precachePaths.has(url.pathname)) {
    fetchEvent.respondWith(shellResponse(url.pathname, request));
  }
});

worker.addEventListener("push", (event) => {
  const pushEvent = event as WorkerPushEvent;
  pushEvent.waitUntil(showPushNotification(pushEvent));
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
  await Promise.all(
    names
      .filter(
        (name) => name.startsWith("weblounge-shell-") && name !== shellCache,
      )
      .map((name) => caches.delete(name)),
  );
  await worker.clients.claim();
}

async function shellResponse(
  cacheKey: string,
  request: Request,
): Promise<Response> {
  const cached = await caches.match(cacheKey, { cacheName: shellCache });
  return cached ?? fetch(request);
}

async function showPushNotification(event: WorkerPushEvent): Promise<void> {
  let route: StoredRoute | undefined;
  let presentation = genericNotification();
  try {
    const envelope = pushEnvelope(event.data?.json());
    route = await findRoute(envelope.routeId);
    if (route === undefined) throw new Error("push route is unavailable");
    presentation = genericNotification(route.networkLabel);
    let plaintext: Uint8Array<ArrayBuffer>;
    try {
      plaintext = await decryptPushPayload(
        decodePushBase64Url(envelope.ciphertext),
        route.privateKey,
        route.p256dh,
        route.auth,
      );
    } catch (error: unknown) {
      await markForReregistration(route).catch(() => undefined);
      throw error;
    }
    const parsed = await parsePushPayload(new TextDecoder().decode(plaintext));
    presentation = notificationFor(route, parsed);
    if (isChatPayload(parsed)) {
      await storePushedMessage(route, parsed).catch(() => undefined);
    }
  } catch {}
  await worker.registration.showNotification(
    presentation.title,
    presentation.options,
  );
}

function genericNotification(networkLabel?: string): NotificationPresentation {
  return {
    title: "New message",
    options: {
      ...(networkLabel === undefined ? {} : { body: networkLabel }),
      data: { route: "/" },
    },
  };
}

function notificationFor(
  route: StoredRoute,
  event: ParsedPushEvent,
): NotificationPresentation {
  if (isChatPayload(event)) {
    const direct = sameIrcName(event.target, route.nickname);
    const buffer = direct ? event.sender : event.target;
    const bufferRoute = bufferPath(route.networkLabel, buffer, direct);
    return {
      title: direct ? event.sender : `${event.sender} in ${event.target}`,
      options: {
        body:
          event.type === "action"
            ? `* ${event.sender} ${event.text}`
            : event.text,
        tag: `${route.networkId}/${buffer.toLowerCase()}`,
        data: { route: bufferRoute },
      },
    };
  }
  if (event.type === "invite") {
    const bufferRoute = bufferPath(route.networkLabel, event.target, false);
    return {
      title: event.sender,
      options: {
        body: `Invited you to ${event.target}`,
        tag: `${route.networkId}/${event.target.toLowerCase()}`,
        data: { route: bufferRoute },
      },
    };
  }
  return genericNotification(route.networkLabel);
}

function isChatPayload(
  event: ParsedPushEvent,
): event is Extract<
  ParsedPushEvent,
  { type: "message" | "notice" | "action" }
> {
  return ["message", "notice", "action"].includes(event.type);
}

function bufferPath(network: string, buffer: string, direct: boolean): string {
  const destination = direct
    ? `@${encodeURIComponent(buffer)}`
    : encodeURIComponent(buffer.startsWith("#") ? buffer.slice(1) : buffer);
  return `/${encodeURIComponent(network)}/${destination}`;
}

function sameIrcName(first: string, second: string): boolean {
  return first.localeCompare(second, "en", { sensitivity: "base" }) === 0;
}

async function parsePushPayload(line: string): Promise<ParsedPushEvent> {
  parserReady ??= loadPushParser();
  const parser = await parserReady;
  return decodeParsedEvent(JSON.parse(parser.parse_push_payload_json(line)));
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

function decodeParsedEvent(value: unknown): ParsedPushEvent {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw new Error("invalid parsed push event");
  }
  if (value.type === "ping") return { type: "ping" };
  if (
    value.type === "markread" &&
    "target" in value &&
    typeof value.target === "string" &&
    "until" in value &&
    typeof value.until === "string"
  ) {
    return { type: value.type, target: value.target, until: value.until };
  }
  if (
    value.type === "invite" &&
    "sender" in value &&
    typeof value.sender === "string" &&
    "target" in value &&
    typeof value.target === "string"
  ) {
    return { type: value.type, sender: value.sender, target: value.target };
  }
  if (
    ["message", "notice", "action"].includes(String(value.type)) &&
    "sender" in value &&
    typeof value.sender === "string" &&
    "target" in value &&
    typeof value.target === "string" &&
    "msgid" in value &&
    typeof value.msgid === "string" &&
    "time" in value &&
    typeof value.time === "string" &&
    "text" in value &&
    typeof value.text === "string"
  ) {
    return value as ParsedPushEvent;
  }
  throw new Error("invalid parsed push event");
}

async function findRoute(routeId: string): Promise<StoredRoute | undefined> {
  const database = await openDatabase(pushDatabase);
  const transaction = database.transaction(routesStore, "readonly");
  const routes = await requestResult(
    transaction.objectStore(routesStore).getAll(),
  );
  await transactionDone(transaction);
  return routes
    .map(decodeStoredRoute)
    .find((route) => route.routeId === routeId);
}

async function markForReregistration(route: StoredRoute): Promise<void> {
  const database = await openDatabase(pushDatabase);
  const transaction = database.transaction(routesStore, "readwrite");
  transaction.objectStore(routesStore).put({
    ...route,
    needsReregistration: true,
  });
  await transactionDone(transaction);
}

async function storePushedMessage(
  route: StoredRoute,
  message: Extract<ParsedPushEvent, { type: "message" | "notice" | "action" }>,
): Promise<void> {
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
    target: message.target,
    msgid: message.msgid,
    time: message.time,
    text: message.text,
    kind: message.type,
  };
  const database = await openDatabase(engineDatabase);
  if (!database.objectStoreNames.contains(engineCacheStore)) return;
  const transaction = database.transaction(engineCacheStore, "readwrite");
  const key = textEncoder.encode(
    `pushed-message\0${route.networkLabel}\0${message.msgid}`,
  );
  const value = textEncoder.encode(JSON.stringify(record));
  transaction.objectStore(engineCacheStore).put(value, key);
  await transactionDone(transaction);
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

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
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
