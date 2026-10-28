import type { BufferId } from "../../engine/generated/BufferId";

export type PaneId = string & { readonly paneId: unique symbol };

export interface PaneLeaf {
  readonly kind: "leaf";
  readonly id: PaneId;
  readonly bufferId?: BufferId;
}

export interface PaneLayout {
  readonly root: PaneLeaf;
  readonly focused: PaneId;
  readonly zoomed: false;
}

const initialPaneId = "pane-1" as PaneId;

export function createSinglePane(bufferId?: BufferId): PaneLayout {
  return {
    root:
      bufferId === undefined
        ? { kind: "leaf", id: initialPaneId }
        : { kind: "leaf", id: initialPaneId, bufferId },
    focused: initialPaneId,
    zoomed: false,
  };
}

export function showInFocusedPane(
  layout: PaneLayout,
  bufferId: BufferId,
): PaneLayout {
  return {
    ...layout,
    root: { ...layout.root, bufferId },
  };
}
