import { createSignal } from "solid-js";
import {
  MemberPanel,
  type MemberWindow,
} from "../../features/members/MemberPanel";
import { createHorizontalPan, panCommits } from "../../ui/horizontal-pan";
import { OverlayDrawer } from "../../ui/OverlayDrawer";
import styles from "./MobileMemberDrawer.module.css";

interface MobileMemberDrawerProps {
  readonly bufferTitle: string;
  readonly closing?: boolean | undefined;
  readonly filter: string;
  readonly window: MemberWindow | undefined;
  readonly onClose: () => void;
  readonly onFilter: (filter: string) => void;
  readonly onOpenDirect: (nick: string) => void;
  readonly openProgress?: number | undefined;
  readonly openReturning?: boolean | undefined;
  readonly onOpenReturnEnd?: (() => void) | undefined;
  readonly onRequestRange: (offset: number) => void;
}

export function MobileMemberDrawer(props: MobileMemberDrawerProps) {
  let requestClose = props.onClose;
  let settledOpen = () => false;
  const [dragProgress, setDragProgress] = createSignal<number>();
  const [dragReturning, setDragReturning] = createSignal(false);
  const activeProgress = () => props.openProgress ?? dragProgress();
  const returnDrawer = () => {
    if ((dragProgress() ?? 0) === 0) {
      setDragProgress(undefined);
      return;
    }
    setDragReturning(true);
    setDragProgress(0);
  };
  const gesture = createHorizontalPan({
    commitRatio: 0.4,
    commitVelocity: 0.25,
    debugRegion: "member-close",
    direction: "right",
    onCancel: returnDrawer,
    onCommit: () => requestClose(),
    onProgress: (progress) => {
      setDragReturning(false);
      setDragProgress(progress);
    },
  });
  const begin = (event: PointerEvent) => {
    const target = event.target as Element;
    if (
      !settledOpen() ||
      target.closest("input, [data-selectable], [data-horizontal-scroll]")
    )
      return;
    gesture.begin(
      event,
      (event.currentTarget as Element).getBoundingClientRect().width,
    );
  };
  return (
    <OverlayDrawer
      closeLabel="Close member list"
      closing={props.closing}
      dragProgress={activeProgress()}
      dragReturning={props.openReturning || dragReturning() || undefined}
      edge="right"
      label="Members"
      onClose={props.onClose}
      onDragReturnEnd={() => {
        if (props.openProgress !== undefined) {
          props.onOpenReturnEnd?.();
          return;
        }
        setDragProgress(undefined);
        setDragReturning(false);
      }}
      width="min(300px, 82%)"
    >
      {(close, open) => {
        requestClose = close;
        settledOpen = open;
        return (
          <div
            class={styles.content}
            data-member-drawer="true"
            onLostPointerCapture={gesture.lostCapture}
            onPointerCancel={gesture.cancel}
            onPointerDown={begin}
            onPointerMove={gesture.move}
            onPointerUp={gesture.end}
          >
            <MemberPanel
              autofocusFilter={false}
              bufferTitle={props.bufferTitle}
              closeLabel="Close member list"
              filter={props.filter}
              onClose={close}
              onFilter={props.onFilter}
              onOpenDirect={(nick) => {
                props.onOpenDirect(nick);
                close();
              }}
              onRequestRange={props.onRequestRange}
              presentation="mobile"
              window={props.window}
            />
          </div>
        );
      }}
    </OverlayDrawer>
  );
}

export function swipeClosesDrawer(
  distance: number,
  width: number,
  velocity: number,
): boolean {
  return panCommits(distance, width, velocity, 0.4, 0.25);
}
