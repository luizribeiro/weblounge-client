import { hostShell } from "../host-shell";
import { tauriInvoke } from "../tauri-invoke";
import type { CreateRouteKeysRequest } from "./generated/CreateRouteKeysRequest";
import type { DeliveredNotification } from "./generated/DeliveredNotification";
import type { DropRouteKeysRequest } from "./generated/DropRouteKeysRequest";
import type { NativeCommand } from "./generated/NativeCommand";
import type { PushedMessage } from "./generated/PushedMessage";
import type { PushPermission } from "./generated/PushPermission";
import type { PushTarget } from "./generated/PushTarget";
import type { RemoveDeliveredNotificationsRequest } from "./generated/RemoveDeliveredNotificationsRequest";
import type { RouteKeys } from "./generated/RouteKeys";
import type { SetBadgeRequest } from "./generated/SetBadgeRequest";
import type { WriteNotificationCountsRequest } from "./generated/WriteNotificationCountsRequest";

interface Signature<Request, Response> {
  readonly request: Request;
  readonly response: Response;
}

type NoRequest = undefined;

interface NativeCommandSignatures
  extends Record<NativeCommand, Signature<unknown, unknown>> {
  readonly request_push_permission: Signature<NoRequest, PushPermission>;
  readonly push_target: Signature<NoRequest, PushTarget | null>;
  readonly create_route_keys: Signature<CreateRouteKeysRequest, RouteKeys>;
  readonly drop_route_keys: Signature<DropRouteKeysRequest, null>;
  readonly take_pushed_messages: Signature<NoRequest, readonly PushedMessage[]>;
  readonly set_badge: Signature<SetBadgeRequest, null>;
  readonly write_notification_counts: Signature<
    WriteNotificationCountsRequest,
    null
  >;
  readonly delivered_notifications: Signature<
    NoRequest,
    readonly DeliveredNotification[]
  >;
  readonly remove_delivered_notifications: Signature<
    RemoveDeliveredNotificationsRequest,
    null
  >;
}

type RequestArguments<C extends NativeCommand> =
  NativeCommandSignatures[C]["request"] extends NoRequest
    ? []
    : [request: NativeCommandSignatures[C]["request"]];

export type NativeResponse<C extends NativeCommand> =
  NativeCommandSignatures[C]["response"];

export interface NativeBridge {
  call<C extends NativeCommand>(
    command: C,
    ...request: RequestArguments<C>
  ): Promise<NativeResponse<C>>;
}

/** The iOS shell's commands; absent in every other host. */
export function nativeBridge(
  scope: Pick<Window, "__WEBLOUNGE_SHELL__" | "__TAURI_INTERNALS__"> = window,
): NativeBridge | undefined {
  if (hostShell(scope) !== "ios-app") return undefined;
  const invoke = tauriInvoke(scope);
  if (invoke === undefined) return undefined;
  return {
    call<C extends NativeCommand>(
      command: C,
      ...[request]: RequestArguments<C>
    ): Promise<NativeResponse<C>> {
      const answer = invoke(
        command,
        request === undefined ? undefined : { request },
      );
      // The shell serializes its answers from the Rust types this TypeScript is generated from.
      return answer as Promise<NativeResponse<C>>;
    },
  };
}
