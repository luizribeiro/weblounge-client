import { createEffect, createSignal, onCleanup, splitProps } from "solid-js";
import { DesktopShell, type DesktopShellProps } from "./desktop/DesktopShell";
import { MobileShell } from "./mobile/MobileShell";
import {
  observeContainerShell,
  type Shell,
  shellForWidth,
} from "./shell-selection";

export function ResponsiveShell(props: DesktopShellProps) {
  const [, sharedProps] = splitProps(props, [
    "activeBufferId",
    "focusRequest",
    "onFocusRequestHandled",
    "onSelectBuffer",
  ]);
  const [shell, setShell] = createSignal<Shell>("desktop");
  const [activeBufferId, setActiveBufferId] = createSignal<number>();
  const [pendingFocusRequest, setPendingFocusRequest] =
    createSignal<DesktopShellProps["focusRequest"]>();
  const [mobileInitialBufferId, setMobileInitialBufferId] =
    createSignal<number>();
  let observedFocusRequest: DesktopShellProps["focusRequest"];
  let measured = false;
  let stopObserving = () => {};

  const selectShell = (next: Shell) => {
    setShell((current) => {
      if (measured && current === "desktop" && next === "mobile") {
        setMobileInitialBufferId(activeBufferId());
      }
      if (next === "desktop") setMobileInitialBufferId(undefined);
      measured = true;
      return next;
    });
  };

  createEffect(() => {
    const request = props.focusRequest;
    if (request === undefined || request === observedFocusRequest) return;
    observedFocusRequest = request;
    setActiveBufferId(request.bufferId);
    setPendingFocusRequest(request);
  });
  createEffect(() => {
    if (activeBufferId() !== undefined) return;
    const preferred =
      props.buffers.find((buffer) => buffer.kind === "channel") ??
      props.buffers.find((buffer) => buffer.kind === "direct") ??
      props.buffers[0];
    if (preferred !== undefined) setActiveBufferId(preferred.id);
  });
  onCleanup(() => stopObserving());

  return (
    <div
      data-shell-container="true"
      ref={(element) => {
        const width = element.getBoundingClientRect().width;
        if (width > 0) selectShell(shellForWidth(width));
        stopObserving();
        stopObserving = observeContainerShell(element, selectShell);
      }}
      style={{ height: "100%" }}
    >
      {shell() === "mobile" ? (
        <MobileShell
          {...sharedProps}
          focusRequest={pendingFocusRequest()}
          initialBufferId={mobileInitialBufferId()}
          onFocusRequestHandled={(request) =>
            setPendingFocusRequest((current) =>
              current === request ? undefined : current,
            )
          }
          onSelectBuffer={setActiveBufferId}
        />
      ) : (
        <DesktopShell
          {...sharedProps}
          activeBufferId={activeBufferId()}
          focusRequest={pendingFocusRequest()}
          onFocusRequestHandled={(request) =>
            setPendingFocusRequest((current) =>
              current === request ? undefined : current,
            )
          }
          onSelectBuffer={setActiveBufferId}
        />
      )}
    </div>
  );
}
