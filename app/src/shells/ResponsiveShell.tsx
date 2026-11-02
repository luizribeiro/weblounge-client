import { createEffect, createSignal, splitProps } from "solid-js";
import {
  selectBuffer as applyBufferSelection,
  type BufferSelection,
} from "../navigation/buffer-selection";
import { platformEnvironment } from "../platform/environment";
import { DesktopShell, type DesktopShellProps } from "./desktop/DesktopShell";
import { MobileShell } from "./mobile/MobileShell";

export function ResponsiveShell(props: DesktopShellProps) {
  const platform = platformEnvironment();
  const [, sharedProps] = splitProps(props, [
    "activeBufferId",
    "bufferRemoval",
    "focusRequest",
    "onFocusRequestHandled",
    "onSelectBuffer",
    "pathForBuffer",
  ]);
  const initialSelection: BufferSelection =
    props.activeBufferId === undefined
      ? { bufferId: undefined, priority: "none" }
      : { bufferId: props.activeBufferId, priority: "initial" };
  const [selection, setSelection] = createSignal(initialSelection);
  const [pendingFocusRequest, setPendingFocusRequest] =
    createSignal<DesktopShellProps["focusRequest"]>();
  const [mobileInitialBufferId, setMobileInitialBufferId] =
    createSignal<number>();
  let observedFocusRequest: DesktopShellProps["focusRequest"];
  let previousShell = platform.environment().shell;

  createEffect(() => {
    const removal = props.bufferRemoval;
    if (removal === undefined || selection().bufferId !== removal.bufferId)
      return;
    if (removal.previousBufferId === undefined) {
      setSelection({ bufferId: undefined, priority: "none" });
      if (platform.environment().shell === "desktop")
        window.history.replaceState(window.history.state, "", "/");
      return;
    }
    setSelection({
      bufferId: removal.previousBufferId,
      priority: "explicit",
    });
    props.onSelectBuffer?.(removal.previousBufferId);
    if (platform.environment().shell === "desktop") {
      const path = props.pathForBuffer?.(removal.previousBufferId);
      if (path !== undefined)
        window.history.replaceState(window.history.state, "", path);
    }
  });
  createEffect(() => {
    const activeBufferId = props.activeBufferId;
    if (activeBufferId !== undefined)
      setSelection((current) =>
        applyBufferSelection(current, activeBufferId, "initial"),
      );
  });
  createEffect(() => {
    const request = props.focusRequest;
    if (request === undefined || request === observedFocusRequest) return;
    observedFocusRequest = request;
    setSelection((current) =>
      applyBufferSelection(current, request.bufferId, "explicit"),
    );
    setPendingFocusRequest(request);
  });
  createEffect(() => {
    const current = selection();
    if (current.priority === "initial" || current.priority === "explicit")
      return;
    const preferred =
      props.buffers.find(
        (buffer) => buffer.kind === "channel" && buffer.available !== false,
      ) ??
      props.buffers.find(
        (buffer) => buffer.kind === "direct" && buffer.available !== false,
      ) ??
      props.buffers.find((buffer) => buffer.available !== false);
    const selected = props.buffers.find(
      (buffer) => buffer.id === current.bufferId,
    );
    if (
      preferred !== undefined &&
      (selected === undefined ||
        bufferFallbackRank(preferred.kind) > bufferFallbackRank(selected.kind))
    )
      setSelection((current) =>
        applyBufferSelection(current, preferred.id, "fallback"),
      );
  });
  createEffect(() => {
    const shell = platform.environment().shell;
    if (previousShell === "desktop" && shell === "mobile") {
      setMobileInitialBufferId(selection().bufferId);
    } else if (shell === "desktop") {
      setMobileInitialBufferId(undefined);
    }
    previousShell = shell;
  });
  const selectBuffer = (bufferId: number) => {
    setSelection((current) =>
      applyBufferSelection(current, bufferId, "explicit"),
    );
    props.onSelectBuffer?.(bufferId);
  };

  return (
    <div data-shell-container="true">
      {platform.environment().shell === "mobile" ? (
        <MobileShell
          {...sharedProps}
          bufferRemoval={props.bufferRemoval}
          focusRequest={pendingFocusRequest()}
          initialBufferId={mobileInitialBufferId() ?? props.activeBufferId}
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
          activeBufferId={selection().bufferId}
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

function bufferFallbackRank(
  kind: DesktopShellProps["buffers"][number]["kind"],
): number {
  if (kind === "channel") return 2;
  if (kind === "direct") return 1;
  return 0;
}
