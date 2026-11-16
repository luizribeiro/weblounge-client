import type { ApnsEnvironment } from "./generated/ApnsEnvironment";
import type { AppLifecycle } from "./generated/AppLifecycle";
import type { PageEvent } from "./generated/PageEvent";
import type { PushTarget } from "./generated/PushTarget";

type PageEventName = PageEvent["name"];
type PageEventDetail<Name extends PageEventName> = Extract<
  PageEvent,
  { name: Name }
>["detail"];

export type NativePageEventHandlers = {
  readonly [Name in PageEventName]?: (detail: PageEventDetail<Name>) => void;
};

const lifecycles: readonly AppLifecycle[] = ["foreground", "background"];
const apnsEnvironments: readonly ApnsEnvironment[] = ["production", "sandbox"];
const apnsToken = /^(?:[0-9a-f]{2}){32,}$/u;

function readPushTarget(detail: unknown): PushTarget | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const { platform, token, environment } = detail as Record<string, unknown>;
  const knownEnvironment = apnsEnvironments.find(
    (known) => known === environment,
  );
  if (
    platform !== "apns" ||
    typeof token !== "string" ||
    !apnsToken.test(token)
  )
    return undefined;
  return knownEnvironment === undefined
    ? undefined
    : { platform, token, environment: knownEnvironment };
}

const detailReaders: {
  readonly [Name in PageEventName]: (
    detail: unknown,
  ) => PageEventDetail<Name> | undefined;
} = {
  "weblounge:open-route": (detail) =>
    typeof detail === "string" ? detail : undefined,
  "weblounge:lifecycle": (detail) =>
    lifecycles.find((lifecycle) => lifecycle === detail),
  "weblounge:push-target": readPushTarget,
};

/** Listens for the shell's page events, dropping any whose detail breaks the contract. */
export function observeNativePageEvents(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  handlers: NativePageEventHandlers,
): () => void {
  const handled = (Object.keys(detailReaders) as PageEventName[]).filter(
    (name) => handlers[name] !== undefined,
  );
  const listeners = handled.map((name) => {
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      dispatch(name, event.detail, handlers);
    };
    target.addEventListener(name, listener);
    return () => target.removeEventListener(name, listener);
  });
  return () => {
    for (const remove of listeners) remove();
  };
}

function dispatch<Name extends PageEventName>(
  name: Name,
  detail: unknown,
  handlers: NativePageEventHandlers,
): void {
  const read = detailReaders[name](detail);
  if (read !== undefined) handlers[name]?.(read);
}
