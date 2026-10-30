import { createEffect, createSignal } from "solid-js";
import { platformEnvironment } from "../platform/environment";
import { DesktopShell, type DesktopShellProps } from "./desktop/DesktopShell";
import { MobileShell } from "./mobile/MobileShell";

export function ResponsiveShell(props: DesktopShellProps) {
  const platform = platformEnvironment();
  const [activeBufferId, setActiveBufferId] = createSignal<number>();
  const [mobileInitialBufferId, setMobileInitialBufferId] =
    createSignal<number>();
  let previousShell = platform.environment().shell;

  createEffect(() => {
    const requested = props.focusRequest?.bufferId;
    if (requested !== undefined) setActiveBufferId(requested);
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

  return (
    <div data-shell-container="true" style={{ height: "100%" }}>
      {platform.environment().shell === "mobile" ? (
        <MobileShell
          {...props}
          initialBufferId={mobileInitialBufferId()}
          onSelectBuffer={setActiveBufferId}
        />
      ) : (
        <DesktopShell
          {...props}
          activeBufferId={activeBufferId()}
          onSelectBuffer={setActiveBufferId}
        />
      )}
    </div>
  );
}
