import { createEffect, createSignal, splitProps } from "solid-js";
import { platformEnvironment } from "../platform/environment";
import { DesktopShell, type DesktopShellProps } from "./desktop/DesktopShell";
import { MobileShell } from "./mobile/MobileShell";

export function ResponsiveShell(props: DesktopShellProps) {
  const platform = platformEnvironment();
  const [, sharedProps] = splitProps(props, [
    "activeBufferId",
    "focusRequest",
    "onFocusRequestHandled",
    "onSelectBuffer",
    "pathForBuffer",
  ]);
  const [activeBufferId, setActiveBufferId] = createSignal(
    props.activeBufferId,
  );
  const [pendingFocusRequest, setPendingFocusRequest] =
    createSignal<DesktopShellProps["focusRequest"]>();
  const [mobileInitialBufferId, setMobileInitialBufferId] =
    createSignal<number>();
  let observedFocusRequest: DesktopShellProps["focusRequest"];
  let previousShell = platform.environment().shell;

  createEffect(() => {
    if (props.activeBufferId !== undefined)
      setActiveBufferId(props.activeBufferId);
  });
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
  createEffect(() => {
    const shell = platform.environment().shell;
    if (previousShell === "desktop" && shell === "mobile") {
      setMobileInitialBufferId(activeBufferId());
    } else if (shell === "desktop") {
      setMobileInitialBufferId(undefined);
    }
    previousShell = shell;
  });
  const selectBuffer = (bufferId: number) => {
    setActiveBufferId(bufferId);
    props.onSelectBuffer?.(bufferId);
  };

  return (
    <div data-shell-container="true" style={{ height: "100%" }}>
      {platform.environment().shell === "mobile" ? (
        <MobileShell
          {...sharedProps}
          focusRequest={pendingFocusRequest()}
          initialBufferId={mobileInitialBufferId()}
          onFocusRequestHandled={(request) =>
            setPendingFocusRequest((current) =>
              current === request ? undefined : current,
            )
          }
          onSelectBuffer={selectBuffer}
          pathForBuffer={props.pathForBuffer}
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
          onSelectBuffer={selectBuffer}
          pathForBuffer={props.pathForBuffer}
        />
      )}
    </div>
  );
}
