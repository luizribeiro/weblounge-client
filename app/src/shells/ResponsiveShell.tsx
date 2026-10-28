import { createEffect, createSignal, onCleanup } from "solid-js";
import { DesktopShell, type DesktopShellProps } from "./desktop/DesktopShell";
import { MobileShell } from "./mobile/MobileShell";
import {
  observeContainerShell,
  type Shell,
  shellForWidth,
} from "./shell-selection";

export function ResponsiveShell(props: DesktopShellProps) {
  const [shell, setShell] = createSignal<Shell>("desktop");
  const [activeBufferId, setActiveBufferId] = createSignal<number>();
  const [mobileInitialBufferId, setMobileInitialBufferId] =
    createSignal<number>();
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
