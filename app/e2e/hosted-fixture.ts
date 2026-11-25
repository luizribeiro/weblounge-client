import { expect, type Page, type Route } from "@playwright/test";
import type { ReleaseChannel } from "../src/engine/generated/ReleaseChannel";
import { installFakeOAuth, oauthIssuer } from "./fake-oauth-route";

export async function installHostedConfig(
  page: Page,
  channel?: ReleaseChannel,
): Promise<() => string> {
  let redirectUri = "";
  await installFakeOAuth(page);
  await page.route("**/config.json", async (route) => {
    redirectUri = new URL("/", route.request().url()).href;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...hostedConfig(route.request().url()),
        ...(channel === undefined ? {} : { channel }),
      }),
    });
  });
  return () => redirectUri;
}

export function hostedConfig(requestUrl: string) {
  return {
    mode: "hosted",
    network: {
      name: "weblounge",
      endpoint: "wss://beta.weblounge.org/socket",
      autojoin: ["#lounge"],
    },
    oauth: {
      issuer: oauthIssuer,
      client_id: "weblounge-client",
      redirect_uri: new URL("/", requestUrl).href,
      session_token_endpoint: `${oauthIssuer}/oauth/session-token` as
        | string
        | undefined,
    },
  };
}

export async function expectHostedConnection(page: Page): Promise<void> {
  await expect
    .poll(async () =>
      page
        .evaluate(() => {
          const requests = Reflect.get(globalThis, "hostedEngineRequests");
          return Array.isArray(requests) ? requests : [];
        })
        .catch(() => []),
    )
    .toContainEqual(expect.objectContaining({ type: "reconnect_hosted" }));
}

export async function expectHostedToken(
  page: Page,
  token: string,
  requestType = "reconnect_hosted",
): Promise<void> {
  await expect
    .poll(async () =>
      page
        .evaluate(() => {
          const requests = Reflect.get(globalThis, "hostedEngineRequests");
          return Array.isArray(requests) ? requests : [];
        })
        .catch(() => []),
    )
    .toContainEqual(
      expect.objectContaining({ type: requestType, oauth_token: token }),
    );
}

export async function fulfillSessionPreflight(
  route: Route,
  origin: string,
): Promise<void> {
  await route.fulfill({
    status: 204,
    headers: {
      ...sessionCors(origin),
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Max-Age": "3600",
    },
  });
}

export function sessionCors(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Origin": origin,
  };
}

export async function fulfillSessionToken(
  route: Route,
  redirectUri: string,
  token: string,
): Promise<void> {
  await route.fulfill({
    contentType: "application/json",
    headers: sessionCors(new URL(redirectUri).origin),
    body: JSON.stringify({
      access_token: token,
      token_type: "Bearer",
      expires_in: 900,
    }),
  });
}

export async function installFakeEngine(
  page: Page,
  holdConnection = false,
  worker: "shared" | "dedicated" = "shared",
) {
  await page.addInitScript((workerKind) => {
    Reflect.set(globalThis, "hostedWorkerKind", workerKind);
  }, worker);
  await page.addInitScript((holdHostedConnection) => {
    const workerKind = Reflect.get(globalThis, "hostedWorkerKind");
    Reflect.set(globalThis, "hostedEngineRequests", []);
    Reflect.set(globalThis, "hostedStartupSequence", []);
    Reflect.set(globalThis, "pushRegistrationSequence", []);
    let emittedPushRequirementBurst = false;
    let pushDevice: {
      relay: string;
      device_id: string;
      secret: string;
    } | null = null;
    if (holdHostedConnection) {
      const originalFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (new URL(url, location.href).pathname === "/config.json") {
          const sequence = Reflect.get(globalThis, "hostedStartupSequence");
          if (Array.isArray(sequence)) sequence.push("config");
        }
        return originalFetch(input, init);
      };
    }
    class FakePort extends EventTarget {
      postMessage(message: unknown) {
        if (typeof message !== "object" || message === null) return;
        const envelope = message as {
          type?: string;
          payload?: {
            id?: string;
            request?: { type?: string; credentials?: typeof pushDevice };
          };
        };
        if (envelope.type === "hello") {
          this.emit({
            type: "ready",
            engine_instance: "hosted-e2e",
            revision: 0,
          });
          this.emit({ type: "command_specs_changed", specs: [] });
          Reflect.set(globalThis, "emitHostedEngineEvent", (event: unknown) =>
            this.emit(event),
          );
          return;
        }
        const request = envelope.payload?.request;
        const id = envelope.payload?.id;
        if (request?.type === "ping") {
          this.emit({ type: "pong", id });
          return;
        }
        if (request?.type === "diagnostic") {
          this.emit({
            type: "diagnostic",
            command_id: id,
            message: "wasm worker round trip complete",
          });
        }
        if (request?.type === "prepare_hosted") {
          const requests = Reflect.get(globalThis, "hostedEngineRequests");
          if (Array.isArray(requests)) requests.push(request);
          this.emit({
            type: "network_state_changed",
            network: {
              id: 1,
              label: "weblounge",
              nickname: "weblounge",
              state: "connecting",
            },
          });
          if (Reflect.get(globalThis, "hostedCachedChatList") === true) {
            this.emit({
              type: "buffers_changed",
              network_id: 1,
              buffers: [
                {
                  id: 2,
                  network_id: 1,
                  kind: "channel",
                  sync_state: "pending",
                  title: "#cached",
                  draft_key: "10:weblounge:rfc1459:#cached",
                  topic: null,
                  member_count: 0,
                  unread: 1,
                  mentions: 0,
                  preview: "available before credentials",
                },
              ],
            });
          }
        }
        if (request?.type === "load_push_device") {
          const storedPushDevice = localStorage.getItem("e2e.push-device");
          this.emit({
            type: "push_device_loaded",
            command_id: id,
            credentials:
              storedPushDevice === null
                ? pushDevice
                : JSON.parse(storedPushDevice),
          });
        }
        if (request?.type === "load_notification_prompt_dismissal") {
          if (Reflect.get(globalThis, "hangNotificationPromptRead") === true)
            return;
          if (Reflect.get(globalThis, "failNotificationPromptRead") === true) {
            this.emit({
              type: "command_rejected",
              id,
              message_key: "engine.storage_unavailable",
            });
            return;
          }
          this.emit({
            type: "notification_prompt_dismissal_loaded",
            command_id: id,
            dismissed:
              localStorage.getItem("e2e.notification-prompt-dismissed") ===
              "true",
          });
        }
        if (
          request?.type === "load_settings" ||
          request?.type === "change_setting"
        ) {
          const stored = localStorage.getItem("e2e.settings");
          const app = {
            theme: "system",
            message_density: "cozy",
            unread_tab_indicator: true,
            push_on_this_device: true,
            page_notifications: true,
            ...(stored === null ? {} : JSON.parse(stored)),
          };
          if (request.type === "load_settings") {
            this.emit({
              type: "settings_loaded",
              command_id: id,
              settings: { app },
            });
          } else {
            const { setting } = (
              request as unknown as {
                change: { setting: { key: string; value: unknown } };
              }
            ).change;
            const changed = { ...app, [setting.key]: setting.value };
            localStorage.setItem("e2e.settings", JSON.stringify(changed));
            this.emit({ type: "settings_changed", settings: { app: changed } });
          }
        }
        if (request?.type === "dismiss_notification_prompt") {
          localStorage.setItem("e2e.notification-prompt-dismissed", "true");
        }
        if (request?.type === "store_push_device") {
          pushDevice = request.credentials ?? null;
          localStorage.setItem("e2e.push-device", JSON.stringify(pushDevice));
        }
        if (request?.type === "clear_push_device") {
          pushDevice = null;
          localStorage.removeItem("e2e.push-device");
        }
        if (request?.type === "ensure_push") {
          const requests = Reflect.get(globalThis, "hostedEngineRequests");
          if (Array.isArray(requests)) requests.push(request);
          const routeId =
            typeof request.route === "object" &&
            request.route !== null &&
            "route_id" in request.route &&
            typeof request.route.route_id === "string"
              ? request.route.route_id
              : "unknown-route";
          const sequence = Reflect.get(globalThis, "pushRegistrationSequence");
          if (Array.isArray(sequence)) sequence.push(`ensure:${routeId}`);
          const unsupported = Reflect.get(globalThis, "hostedPushUnsupported");
          if (typeof unsupported === "string") {
            this.emit({
              type: "push_state_changed",
              network_id: 1,
              state: { status: "unsupported", reason: unsupported },
            });
          }
          Reflect.set(globalThis, "completePushRegistration", () => {
            this.emit({
              type: "push_state_changed",
              network_id: 1,
              state: { status: "registered", route_id: routeId },
            });
          });
          Reflect.set(globalThis, "failPushRegistration", () => {
            this.emit({
              type: "push_state_changed",
              network_id: 1,
              state: {
                status: "failed",
                route_id: routeId,
                reason: "invalid_parameters",
              },
            });
          });
          if (!emittedPushRequirementBurst) {
            emittedPushRequirementBurst = true;
            const configuredCount = Reflect.get(
              globalThis,
              "hostedPushRequirementCount",
            );
            const requirementCount =
              typeof configuredCount === "number" ? configuredCount : 1;
            for (let index = 1; index < requirementCount; index += 1) {
              this.emit({
                type: "push_route_required",
                network_id: 1,
                vapid: "home-vapid",
                previous_route_id: null,
              });
            }
          }
        }
        if (request?.type === "announce_push_route") {
          const requests = Reflect.get(globalThis, "hostedEngineRequests");
          if (Array.isArray(requests)) requests.push(request);
          if (
            Reflect.get(globalThis, "hostedPushEnabled") === true &&
            Reflect.get(globalThis, "hostedConnected") === true
          ) {
            this.emit({
              type: "push_route_required",
              network_id: 1,
              vapid: "home-vapid",
              previous_route_id: null,
            });
          }
        }
        if (request?.type === "unregister_push_route") {
          const sequence = Reflect.get(globalThis, "pushRegistrationSequence");
          if (Array.isArray(sequence)) {
            sequence.push(
              `unregister:${String(request.route_id)}:${String(request.endpoint)}`,
            );
          }
        }
        if (request?.type === "reconnect_hosted") {
          const requests = Reflect.get(globalThis, "hostedEngineRequests");
          if (Array.isArray(requests)) requests.push(request);
          Reflect.set(globalThis, "requestHostedToken", () => {
            this.emit({ type: "hosted_token_required", network_id: 1 });
          });
          const complete = () => {
            this.emit({
              type: "network_state_changed",
              network: {
                id: 1,
                label: "weblounge",
                nickname: "weblounge",
                account:
                  localStorage.getItem("e2e.hosted-account") ?? "weblounge",
                state: "online",
              },
            });
            this.emit({
              type: "buffers_changed",
              network_id: 1,
              buffers: [
                {
                  id: 1,
                  network_id: 1,
                  kind: "server",
                  sync_state: "synced",
                  title: "weblounge",
                  draft_key: "10:weblounge:rfc1459:weblounge",
                  topic: null,
                  unread: 0,
                  mentions: 0,
                },
                {
                  id: 2,
                  network_id: 1,
                  kind: "channel",
                  sync_state: "synced",
                  title: "#lounge",
                  draft_key: "10:weblounge:rfc1459:#lounge",
                  topic: null,
                  member_count: 0,
                  unread: 0,
                  mentions: 0,
                },
                {
                  id: 3,
                  network_id: 1,
                  kind: "channel",
                  sync_state: "synced",
                  title: "#ops",
                  draft_key: "10:weblounge:rfc1459:#ops",
                  topic: null,
                  member_count: 0,
                  unread: 0,
                  mentions: 0,
                },
                ...(Reflect.get(globalThis, "hostedReadDirect") === true
                  ? [
                      {
                        id: 4,
                        network_id: 1,
                        kind: "direct",
                        sync_state: "synced",
                        title: "mel",
                        draft_key: "10:weblounge:rfc1459:mel",
                        topic: null,
                        unread: 0,
                        mentions: 0,
                        read_at_ms: Date.parse("2026-11-04T19:24:33.000Z"),
                      },
                    ]
                  : []),
              ],
            });
            Reflect.set(
              globalThis,
              "setHostedUnread",
              (unread: number, mentions: number) => {
                this.emit({
                  type: "buffer_updated",
                  buffer: {
                    id: 2,
                    network_id: 1,
                    kind: "channel",
                    sync_state: "synced",
                    title: "#lounge",
                    draft_key: "10:weblounge:rfc1459:#lounge",
                    topic: null,
                    member_count: 0,
                    unread,
                    mentions,
                  },
                });
              },
            );
            Reflect.set(globalThis, "hostedConnected", true);
            if (
              Reflect.get(globalThis, "hostedPushEnabled") === true &&
              Reflect.get(globalThis, "hostedEngineAlreadyConnected") !== true
            ) {
              this.emit({
                type: "push_route_required",
                network_id: 1,
                vapid: "home-vapid",
                previous_route_id: null,
              });
            }
          };
          if (holdHostedConnection) {
            Reflect.set(globalThis, "completeHostedConnection", complete);
          } else {
            complete();
          }
        }
        if (id !== undefined) this.emit({ type: "command_result", id });
      }

      start() {}
      close() {}

      private emit(data: unknown) {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }

    class FakeSharedWorker {
      readonly port = new FakePort();

      constructor() {
        const sequence = Reflect.get(globalThis, "hostedStartupSequence");
        if (Array.isArray(sequence)) sequence.push("worker");
      }
    }
    if (workerKind === "shared") {
      Reflect.set(globalThis, "SharedWorker", FakeSharedWorker);
      return;
    }
    class FakeDedicatedWorker extends FakePort {
      terminate() {}
    }
    Object.defineProperty(globalThis, "SharedWorker", {
      configurable: true,
      value: undefined,
    });
    Reflect.set(globalThis, "Worker", FakeDedicatedWorker);
  }, holdConnection);
}
