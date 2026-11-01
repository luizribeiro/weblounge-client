import { type Accessor, createEffect, createSignal } from "solid-js";

export interface ConnectionProgress {
  readonly active: Accessor<boolean>;
  readonly finishSweep: (event: AnimationEvent) => void;
}

export function createConnectionProgress(
  progressing: Accessor<boolean>,
  stopImmediately: Accessor<boolean>,
): ConnectionProgress {
  const [active, setActive] = createSignal(progressing());
  let finishing = false;

  createEffect(() => {
    if (progressing()) {
      finishing = false;
      setActive(true);
    } else if (stopImmediately()) {
      finishing = false;
      setActive(false);
    } else if (active()) {
      finishing = true;
    }
  });

  return {
    active,
    finishSweep: (event) => {
      if (event.target === event.currentTarget && finishing && !progressing()) {
        finishing = false;
        setActive(false);
      }
    },
  };
}
