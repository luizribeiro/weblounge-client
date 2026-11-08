import {
  ENGINE_DATABASE_NAME,
  ENGINE_DATABASE_VERSION,
} from "./engine/generated/EngineDatabaseSchema";
import {
  type NotificationClients,
  routeNotificationClick,
} from "./platform/push/notification-routing";
import {
  DatabaseTimeoutError,
  databaseDeadlineMs,
  notificationCountsKey,
  openPushDatabase,
  pushRouteIdIndex,
  pushRoutesStore,
  pushStateStore,
  requestResult,
  transactionDone,
} from "./platform/push/push-database";
import {
  decodePushBase64Url,
  decryptPushPayload,
} from "./platform/push/push-decryption";
import {
  type PreparedPushDelivery,
  PushDeliveryCoordinator,
} from "./platform/push/push-delivery-coordinator";
import {
  createPushDeliveryTrace,
  flushDeferredPushDeliveryLog,
  type PushDeliveryEnvironment,
  type PushDeliveryTrace,
} from "./platform/push/push-delivery-log";
import type { PushPresentationState } from "./platform/push/push-delivery-state";
import { replaceDeadlineFallback } from "./platform/push/push-fallback-replacement";
import {
  bufferPath,
  deadlineFallbackNotification,
  genericNotification,
  isChatPayload,
  notificationForLine,
  type ParsedPushEvent,
  sameIrcName,
  withNotificationCount,
} from "./platform/push/push-notification";
import {
  closeNotificationsCoveredByMarkers,
  closeSupersededConversationNotifications,
} from "./platform/push/push-notification-cleanup";
import {
  conversationNotificationCount,
  decodeNotificationState,
  markConversationRead as markNotificationStateRead,
  type NotificationState,
  notificationStateTotal,
  recordPresentedNotification,
} from "./platform/push/push-notification-state";
import {
  readNotificationState,
  updateNotificationState,
} from "./platform/push/push-notification-store";
import {
  PushParserLoader,
  type PushPayloadParser,
} from "./platform/push/push-parser-loader";

declare const SHELL_VERSION: string;
declare const PRECACHE_URLS: readonly string[];
declare const __PUSH_EVENT_HARNESS__: boolean;
declare const __PUSH_DELIVERY_TEST_ENABLED__: boolean;
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

interface PushDeliveryInput {
  readonly event: PushPayloadEvent;
  readonly trace: PushDeliveryTrace;
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
  readonly visibilityState?: string;
  focus(): Promise<WindowClient>;
  navigate(url: string): Promise<WindowClient | null>;
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
const pushNotificationDeadlineMs = 2_000;
const pushFallbackDeadlineMs = 1_500;
const notificationScanDeadlineMs = 500;
const engineCacheStore = "cache";
const textEncoder = new TextEncoder();
const parser = new PushParserLoader(loadPushParser);
const harnessNotifications: Notification[] = [];
let harnessPresentationFailures = 0;
let harnessTagReplacement = true;
const pushDeliveryTestGateReleases = new Map<string, () => void>();
const releasedPushDeliveryTestGates = new Set<string>();
const pendingReceipts = new Set<string>();
const pendingConversationMessages = new Map<
  string,
  PendingConversationMessage
>();
let nextReceiptSequence = 1;

interface PendingConversationMessage {
  readonly receiptId: string;
  readonly receiptSequence: number;
  readonly tag: string;
  readonly messageId: string;
  readonly messageTime: string;
}

type PushPresentation = ReturnType<typeof genericNotification>;
type PushCommit =
  | {
      readonly kind: "visible";
      readonly route: StoredRoute;
      readonly event: ParsedPushEvent | undefined;
      readonly tag: string | undefined;
      readonly receiptId: string;
    }
  | {
      readonly kind: "markread";
      readonly tag: string;
      readonly until: string;
      readonly receiptId: string;
    }
  | { readonly kind: "ping"; readonly receiptId: string }
  | { readonly kind: "fallback"; readonly receiptId: string };

const pushDeliveries = new PushDeliveryCoordinator<
  PushDeliveryInput,
  PushPresentation,
  PushCommit
>({
  fallbackDeadlineMs: pushFallbackDeadlineMs,
  presentationBudgetMs: pushNotificationDeadlineMs,
  generic: () => replaceableGenericNotification(),
  finalFallback: (generic) =>
    genericNotification(generic.options.body, generic.receiptId),
  fallbackCommit: (fallback) => ({
    kind: "fallback",
    receiptId: requiredReceiptId(fallback),
  }),
  present: (presentation, input) =>
    input.trace.measure("notification_show", () => {
      const { options, title } = presentation;
      return showRegistrationNotification(title, options);
    }),
  replace: (fallback, presentation, input) =>
    input.trace.measure("notification_show", () =>
      replaceFallbackNotification(fallback, presentation),
    ),
  dismiss: (fallback, input) =>
    input.trace.measure("fallback_dismiss", () =>
      dismissFallbackNotification(fallback),
    ),
  prepare: preparePushDelivery,
  commit: (commit, input) =>
    input.trace.measure("state_commit", () => commitPushDelivery(commit)),
  reportError: reportPushError,
  retryPrepare: (error) => error instanceof DatabaseTimeoutError,
  complete: async (input, completion) => {
    input.trace.setEnvironment(await pushDeliveryEnvironment());
    await input.trace.complete(completion);
  },
});

worker.importScripts("/push-payload.js");

worker.addEventListener("install", (event) => {
  (event as WorkerEvent).waitUntil(
    precacheShell().then(() => worker.skipWaiting()),
  );
});

worker.addEventListener("activate", (event) => {
  (event as WorkerEvent).waitUntil(
    Promise.all([activateWorker(), flushDeliveryDiagnostics()]),
  );
});

worker.addEventListener("message", (event) => {
  const message = event as WorkerEvent & MessageEvent;
  message.waitUntil(flushDeliveryDiagnostics());
  const data: unknown = message.data;
  if (__PUSH_DELIVERY_TEST_ENABLED__ && isPushDeliveryTestGateRelease(data)) {
    const release = pushDeliveryTestGateReleases.get(data.id);
    if (release === undefined) releasedPushDeliveryTestGates.add(data.id);
    else release();
    return;
  }
  if (__PUSH_EVENT_HARNESS__ && isHarnessPush(data)) {
    harnessPresentationFailures = data.presentationFailures ?? 0;
    harnessTagReplacement = data.tagReplacement ?? true;
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
  if (__PUSH_EVENT_HARNESS__ && isHarnessNotificationClick(data)) {
    const notification = harnessNotifications[0];
    const harnessClients = harnessNotificationClients(data.clientState);
    const handled =
      notification === undefined
        ? Promise.reject(new Error("push harness notification is unavailable"))
        : routeNotificationClick(harnessClients.clients, notification);
    message.waitUntil(
      handled.then(
        () =>
          message.source?.postMessage({
            type: "notification_clicked",
            id: data.id,
            openedRoute: harnessClients.openedRoute(),
          }),
        (error: unknown) =>
          message.source?.postMessage({
            type: "notification_click_failed",
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
  const fetchEvent = event as WorkerEvent & {
    readonly request: Request;
    respondWith(response: Promise<Response>): void;
  };
  const { request } = fetchEvent;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin || url.pathname === "/config.json")
    return;
  if (request.mode === "navigate") {
    fetchEvent.waitUntil(flushDeliveryDiagnostics());
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
  const deliveryId = pushDeliveryTestId(pushEvent.data);
  const delivery = queuePush(pushEvent);
  pushEvent.waitUntil(
    deliveryId === undefined
      ? delivery
      : reportPushDeliveryTestCompletion(deliveryId, delivery),
  );
});

worker.addEventListener("pushsubscriptionchange", (event) => {
  (event as WorkerEvent).waitUntil(notifyWindowsOfSubscriptionChange());
});

worker.addEventListener("notificationclick", (event) => {
  const click = event as WorkerNotificationEvent;
  click.preventDefault();
  click.waitUntil(routeNotificationClick(worker.clients, click.notification));
  click.waitUntil(flushDeliveryDiagnostics());
});

async function flushDeliveryDiagnostics(): Promise<void> {
  await flushDeferredPushDeliveryLog().catch(() => undefined);
}

async function pushDeliveryEnvironment(): Promise<PushDeliveryEnvironment> {
  let visibility: "hidden" | "visible" | undefined;
  try {
    const clients = await worker.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    const states = clients.map(({ visibilityState }) => visibilityState);
    if (states.includes("visible")) visibility = "visible";
    else if (states.includes("hidden")) visibility = "hidden";
  } catch {
    visibility = undefined;
  }
  return {
    ...(typeof navigator === "object" && "locks" in navigator
      ? { locksAvailable: true as const }
      : {}),
    ...(visibility === undefined ? {} : { visibility }),
  };
}

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
  readonly presentationFailures?: number;
  readonly tagReplacement?: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "deliver_push" &&
    "id" in value &&
    typeof value.id === "string" &&
    "payload" in value &&
    typeof value.payload === "string" &&
    (!("presentationFailures" in value) ||
      (typeof value.presentationFailures === "number" &&
        Number.isSafeInteger(value.presentationFailures) &&
        value.presentationFailures >= 0)) &&
    (!("tagReplacement" in value) || typeof value.tagReplacement === "boolean")
  );
}

function isPushDeliveryTestGateRelease(value: unknown): value is {
  readonly type: "release_push_delivery_gate";
  readonly id: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "release_push_delivery_gate" &&
    "id" in value &&
    typeof value.id === "string"
  );
}

function pushDeliveryTestGateId(value: unknown): string | undefined {
  if (!__PUSH_DELIVERY_TEST_ENABLED__) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    !("_webloungeTestDeliveryId" in value) ||
    typeof value._webloungeTestDeliveryId !== "string" ||
    !("_webloungeTestDeliveryGate" in value) ||
    value._webloungeTestDeliveryGate !== true
  ) {
    return undefined;
  }
  return value._webloungeTestDeliveryId;
}

function isHarnessNotificationClick(value: unknown): value is {
  readonly type: "click_notification";
  readonly id: string;
  readonly clientState: "open" | "discarded" | "closed";
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "click_notification" &&
    "id" in value &&
    typeof value.id === "string" &&
    "clientState" in value &&
    ["open", "discarded", "closed"].includes(String(value.clientState))
  );
}

function harnessNotificationClients(state: "open" | "discarded" | "closed"): {
  readonly clients: NotificationClients;
  readonly openedRoute: () => string | undefined;
} {
  let openedRoute: string | undefined;
  const clients = {
    openWindow: async (url: string) => {
      openedRoute = url;
      return null;
    },
    matchAll: async (options: {
      readonly type: "window";
      readonly includeUncontrolled: true;
    }) => {
      if (state === "closed") return [];
      return (await worker.clients.matchAll(options)).map((client) => ({
        focus: async () =>
          state === "open"
            ? client
            : {
                focus: () => client.focus(),
                navigate: (url: string) => client.navigate(url),
                postMessage: () => undefined,
              },
        navigate: (url: string) => client.navigate(url),
        postMessage: (message: unknown) => client.postMessage(message),
      }));
    },
  } as NotificationClients;
  return { clients, openedRoute: () => openedRoute };
}

function queuePush(pushEvent: PushPayloadEvent): Promise<void> {
  return pushDeliveries.enqueue({
    event: pushEvent,
    trace: createPushDeliveryTrace(SHELL_VERSION),
  });
}

function pushDeliveryTestId(
  data: PushPayloadEvent["data"],
): string | undefined {
  if (!__PUSH_DELIVERY_TEST_ENABLED__) return undefined;
  const value: unknown = data?.json();
  return typeof value === "object" &&
    value !== null &&
    "_webloungeTestDeliveryId" in value &&
    typeof value._webloungeTestDeliveryId === "string"
    ? value._webloungeTestDeliveryId
    : undefined;
}

async function reportPushDeliveryTestCompletion(
  id: string,
  delivery: Promise<void>,
): Promise<void> {
  let error: string | undefined;
  try {
    await delivery;
  } catch (reason: unknown) {
    error = pushError(reason);
  }
  const clients = await worker.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of clients) {
    client.postMessage({
      type: "push_delivery_complete",
      id,
      ...(error === undefined ? {} : { error }),
    });
  }
  if (error !== undefined) throw new Error(error);
}

function pushError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return `${error.name}: ${error.message}${error.stack === undefined ? "" : `\n${error.stack}`}`;
}

function reportPushError(error: unknown, input?: PushDeliveryInput): void {
  input?.trace.fail(error);
  console.error("push delivery failed", pushError(error));
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

async function preparePushDelivery(
  input: PushDeliveryInput,
  state: PushPresentationState<PushPresentation>,
): Promise<PreparedPushDelivery<PushPresentation, PushCommit>> {
  const { event, trace } = input;
  const envelope = await trace.measure("envelope_decode", () =>
    pushEnvelope(event.data?.json()),
  );
  const context = await findRouteContext(envelope.routeId, trace);
  const { notificationState, pendingMessages, route } = context;
  state.generic = replaceableGenericNotification(
    route.networkLabel,
    state.generic.receiptId,
  );
  await waitForPushDeliveryTestGate(event.data?.json());
  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    plaintext = await trace.measure("decrypt", () =>
      decryptPushPayload(
        decodePushBase64Url(envelope.ciphertext),
        route.privateKey,
        route.p256dh,
        route.auth,
      ),
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
    (error) => reportPushError(error, input),
    (stage, work) => trace.measure(stage, work),
  );
  if (parsed.event?.type === "markread") {
    return {
      kind: "silent",
      commit: {
        kind: "markread",
        tag: conversationTag(route, parsed.event.target),
        until: parsed.event.until,
        receiptId: requiredReceiptId(state.generic),
      },
    };
  }
  if (parsed.event?.type === "ping") {
    return {
      kind: "silent",
      commit: { kind: "ping", receiptId: requiredReceiptId(state.generic) },
    };
  }
  const receiptId = requiredReceiptId(state.generic);
  const receiptSequence = requiredReceiptSequence(state.generic);
  const presentation =
    parsed.event !== undefined && isChatPayload(parsed.event)
      ? countedChatPresentation(
          parsed.presentation,
          parsed.event,
          notificationState,
          receiptId,
          receiptSequence,
          pendingMessages,
        )
      : parsed.presentation;
  return {
    kind: "visible",
    presentation,
    ...(parsed.event === undefined ? { finalGeneric: true } : {}),
    commit: {
      kind: "visible",
      route,
      event: parsed.event,
      tag: presentation.options.tag,
      receiptId,
    },
  };
}

async function waitForPushDeliveryTestGate(value: unknown): Promise<void> {
  const id = pushDeliveryTestGateId(value);
  if (id === undefined) return;
  if (releasedPushDeliveryTestGates.delete(id)) return;
  await new Promise<void>((resolve) => {
    pushDeliveryTestGateReleases.set(id, resolve);
  });
  pushDeliveryTestGateReleases.delete(id);
}

function replaceableGenericNotification(
  networkLabel?: string,
  receiptId: string = crypto.randomUUID(),
): PushPresentation {
  return {
    ...deadlineFallbackNotification(
      genericNotification(networkLabel, receiptId),
      receiptId,
    ),
    receiptSequence: nextReceiptSequence++,
  };
}

async function commitPushDelivery(commit: PushCommit): Promise<void> {
  try {
    if (commit.kind === "markread") {
      await markConversationRead(commit.tag, commit.until);
      await tidyReadNotifications(false);
      return;
    }
    if (commit.kind === "ping") {
      await tidyReadNotifications();
      return;
    }
    if (commit.kind === "fallback") {
      await recordShownNotification(undefined, undefined);
      return;
    }
    await recordShownNotification(commit.tag, commit.event);
    if (commit.event !== undefined && isChatPayload(commit.event)) {
      await storePushedMessage(commit.route, commit.event);
      if (commit.tag !== undefined) {
        await closeSupersededConversationNotifications(
          registrationNotifications,
          commit.tag,
          {
            receiptId: commit.receiptId,
            messageId: commit.event.msgid,
            messageTime: commit.event.time,
          },
          pendingReceipts,
        );
      }
    }
  } finally {
    pendingReceipts.delete(commit.receiptId);
    pendingConversationMessages.delete(commit.receiptId);
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

async function recordShownNotification(
  tag: string | undefined,
  event: ParsedPushEvent | undefined,
): Promise<void> {
  const chat = event !== undefined && isChatPayload(event) ? event : undefined;
  const total = await updateNotificationState((state) =>
    recordPresentedNotification(state, {
      ...(tag === undefined ? {} : { tag }),
      ...(chat === undefined
        ? {}
        : { messageId: chat.msgid, messageTime: chat.time }),
    }),
  );
  await setWorkerBadge(total);
}

async function markConversationRead(tag: string, until: string): Promise<void> {
  const marker = readMarkerMillis(until);
  if (marker === undefined) return;
  const total = await updateNotificationState((state) =>
    markNotificationStateRead(state, tag, marker),
  );
  await setWorkerBadge(total);
}

async function tidyReadNotifications(recomputeBadge = true): Promise<void> {
  const state = await readNotificationState();
  const readMarkers = new Map(state.readAtMs);
  await closeNotificationsCoveredByMarkers(
    registrationNotifications,
    readMarkers,
  );
  if (recomputeBadge) await setWorkerBadge(notificationStateTotal(state));
}

async function showRegistrationNotification(
  title: string,
  options: NotificationOptions,
): Promise<void> {
  const receiptId = notificationReceiptId({ data: options.data });
  if (receiptId !== undefined) pendingReceipts.add(receiptId);
  const pendingMessage = pendingConversationMessage(options.data);
  if (pendingMessage !== undefined) {
    pendingConversationMessages.set(pendingMessage.receiptId, pendingMessage);
  }
  try {
    await presentRegistrationNotification(title, options);
  } catch (error: unknown) {
    if (receiptId !== undefined) pendingReceipts.delete(receiptId);
    if (pendingMessage !== undefined) {
      pendingConversationMessages.delete(pendingMessage.receiptId);
    }
    throw error;
  }
}

function presentRegistrationNotification(
  title: string,
  options: NotificationOptions,
): Promise<void> {
  if (!__PUSH_EVENT_HARNESS__) {
    return worker.registration.showNotification(title, options);
  }
  if (harnessPresentationFailures > 0) {
    harnessPresentationFailures -= 1;
    return Promise.reject(new Error("injected notification failure"));
  }
  const tag = options.tag ?? "";
  if (harnessTagReplacement && tag.length > 0) {
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
  const request = __PUSH_EVENT_HARNESS__
    ? Promise.resolve([...harnessNotifications])
    : worker.registration.getNotifications();
  return withNotificationScanDeadline(request);
}

async function replaceFallbackNotification(
  fallback: PushPresentation,
  presentation: PushPresentation,
): Promise<boolean> {
  return replaceDeadlineFallback(fallback, presentation, ({ title, options }) =>
    showRegistrationNotification(title, options),
  );
}

async function dismissFallbackNotification(
  fallback: PushPresentation,
): Promise<void> {
  const receiptId = requiredReceiptId(fallback);
  for (const notification of await registrationNotifications()) {
    if (notificationReceiptId(notification) === receiptId) {
      notification.close();
    }
  }
}

function notificationReceiptId(notification: {
  readonly data: unknown;
}): string | undefined {
  const data: unknown = notification.data;
  return typeof data === "object" &&
    data !== null &&
    "receiptId" in data &&
    typeof data.receiptId === "string"
    ? data.receiptId
    : undefined;
}

function requiredReceiptId(presentation: PushPresentation): string {
  if (presentation.receiptId === undefined) {
    throw new Error("push presentation receipt is unavailable");
  }
  return presentation.receiptId;
}

function requiredReceiptSequence(presentation: PushPresentation): number {
  if (presentation.receiptSequence === undefined) {
    throw new Error("push presentation receipt sequence is unavailable");
  }
  return presentation.receiptSequence;
}

function harnessNotificationSnapshots(): readonly unknown[] {
  return harnessNotifications.map(({ body, data, tag, title }) => ({
    body,
    data,
    tag,
    title,
  }));
}

function readMarkerMillis(reference: string): number | undefined {
  const timestamp = reference.startsWith("timestamp=")
    ? reference.slice("timestamp=".length)
    : reference;
  const marker = Date.parse(timestamp);
  return Number.isNaN(marker) ? undefined : marker;
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

async function findRouteContext(
  routeId: string,
  trace: PushDeliveryTrace,
): Promise<{
  readonly route: StoredRoute;
  readonly notificationState: NotificationState;
  readonly pendingMessages: readonly PendingConversationMessage[];
}> {
  const pendingMessages = [...pendingConversationMessages.values()];
  const database = await trace.measure("database_open", () =>
    openPushDatabase(),
  );
  try {
    const [routeRecord, notificationState] = await trace.measure(
      "database_transaction",
      async () => {
        const transaction = database.transaction(
          [pushRoutesStore, pushStateStore],
          "readonly",
        );
        const result = await Promise.all([
          requestResult(
            transaction
              .objectStore(pushRoutesStore)
              .index(pushRouteIdIndex)
              .get(routeId),
          ),
          requestResult(
            transaction.objectStore(pushStateStore).get(notificationCountsKey),
          ),
        ]);
        await transactionDone(transaction);
        return result;
      },
    );
    const storedRoute = await trace.measure("route_lookup", () => {
      if (routeRecord === undefined)
        throw new Error("push route is unavailable");
      return routeRecord;
    });
    const route = await trace.measure("key_lookup", () =>
      decodeStoredRoute(storedRoute),
    );
    return {
      route,
      notificationState: decodeNotificationState(notificationState),
      pendingMessages,
    };
  } finally {
    database.close();
  }
}

function countedChatPresentation(
  presentation: PushPresentation,
  event: Extract<ParsedPushEvent, { type: "message" | "notice" | "action" }>,
  state: NotificationState,
  receiptId: string,
  receiptSequence: number,
  pendingMessages: readonly PendingConversationMessage[],
): PushPresentation {
  const tag = presentation.options.tag;
  if (tag === undefined) return presentation;
  const current = {
    receiptId,
    receiptSequence,
    tag,
    messageId: event.msgid,
    messageTime: event.time,
  };
  for (const pending of [...pendingMessages, current]
    .filter((message) => message.receiptSequence <= receiptSequence)
    .sort((left, right) => left.receiptSequence - right.receiptSequence)) {
    recordPresentedNotification(state, pending);
  }
  const counted = withNotificationCount(
    presentation,
    conversationNotificationCount(state, tag),
  );
  const data = counted.options.data;
  return {
    ...counted,
    options: {
      ...counted.options,
      data:
        typeof data === "object" && data !== null
          ? { ...data, receiptId, receiptSequence }
          : { receiptId, receiptSequence },
    },
  };
}

function pendingConversationMessage(
  data: unknown,
): PendingConversationMessage | undefined {
  if (
    typeof data !== "object" ||
    data === null ||
    !("receiptId" in data) ||
    typeof data.receiptId !== "string" ||
    !("receiptSequence" in data) ||
    typeof data.receiptSequence !== "number" ||
    !("conversationTag" in data) ||
    typeof data.conversationTag !== "string" ||
    !("messageId" in data) ||
    typeof data.messageId !== "string" ||
    !("messageTime" in data) ||
    typeof data.messageTime !== "string"
  ) {
    return undefined;
  }
  return {
    receiptId: data.receiptId,
    receiptSequence: data.receiptSequence,
    tag: data.conversationTag,
    messageId: data.messageId,
    messageTime: data.messageTime,
  };
}

async function withNotificationScanDeadline<T>(
  request: Promise<T>,
): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(
      () => reject(new Error("notification scan timed out")),
      notificationScanDeadlineMs,
    );
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
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
