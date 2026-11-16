import type { AppLifecycle } from "./generated/AppLifecycle";
import type { PageEvent } from "./generated/PageEvent";

type PageEventName = PageEvent["name"];
type PageEventDetail<Name extends PageEventName> = Extract<
  PageEvent,
  { name: Name }
>["detail"];

export type NativePageEventHandlers = {
  readonly [Name in PageEventName]: (detail: PageEventDetail<Name>) => void;
};

const lifecycles: readonly AppLifecycle[] = ["foreground", "background"];

const detailReaders: {
  readonly [Name in PageEventName]: (
    detail: unknown,
  ) => PageEventDetail<Name> | undefined;
} = {
  "weblounge:open-route": (detail) =>
    typeof detail === "string" ? detail : undefined,
  "weblounge:lifecycle": (detail) =>
    lifecycles.find((lifecycle) => lifecycle === detail),
};

/** Listens for the shell's page events, dropping any whose detail breaks the contract. */
export function observeNativePageEvents(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  handlers: NativePageEventHandlers,
): () => void {
  const listeners = (Object.keys(detailReaders) as PageEventName[]).map(
    (name) => {
      const listener = (event: Event) => {
        if (!(event instanceof CustomEvent)) return;
        dispatch(name, event.detail, handlers);
      };
      target.addEventListener(name, listener);
      return () => target.removeEventListener(name, listener);
    },
  );
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
  if (read !== undefined) handlers[name](read);
}
