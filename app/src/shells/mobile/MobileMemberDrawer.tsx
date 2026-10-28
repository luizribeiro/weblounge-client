import {
  MemberPanel,
  type MemberWindow,
} from "../../features/members/MemberPanel";
import styles from "./MobileMemberDrawer.module.css";

interface MobileMemberDrawerProps {
  readonly bufferTitle: string;
  readonly filter: string;
  readonly window: MemberWindow | undefined;
  readonly onClose: () => void;
  readonly onFilter: (filter: string) => void;
  readonly onOpenDirect: (nick: string) => void;
  readonly onRequestRange: (offset: number) => void;
}

export function MobileMemberDrawer(props: MobileMemberDrawerProps) {
  let start: { x: number; time: number; width: number } | undefined;
  const begin = (event: PointerEvent) => {
    const target = event.target as Element;
    if (target.closest("input, [data-selectable], [data-horizontal-scroll]"))
      return;
    start = {
      x: event.clientX,
      time: event.timeStamp,
      width: (event.currentTarget as Element).getBoundingClientRect().width,
    };
  };
  const finish = (event: PointerEvent) => {
    if (start === undefined) return;
    const distance = Math.max(0, event.clientX - start.x);
    const velocity = distance / Math.max(1, event.timeStamp - start.time);
    const closes = swipeClosesDrawer(distance, start.width, velocity);
    start = undefined;
    if (closes) props.onClose();
  };
  return (
    <div class={styles.overlay} data-member-drawer="true">
      <button
        aria-label="Close member list"
        class={styles.backdrop}
        onClick={props.onClose}
        type="button"
      />
      <div
        aria-label="Members"
        aria-modal="true"
        class={styles.drawer}
        onPointerCancel={finish}
        onPointerDown={begin}
        onPointerUp={finish}
        role="dialog"
      >
        <MemberPanel
          bufferTitle={props.bufferTitle}
          closeLabel="Close member list"
          filter={props.filter}
          onClose={props.onClose}
          onFilter={props.onFilter}
          onOpenDirect={props.onOpenDirect}
          onRequestRange={props.onRequestRange}
          window={props.window}
        />
      </div>
    </div>
  );
}

export function swipeClosesDrawer(
  distance: number,
  width: number,
  velocity: number,
): boolean {
  return distance >= width / 3 || velocity >= 0.5;
}
