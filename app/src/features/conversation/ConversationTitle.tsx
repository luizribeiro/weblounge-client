import type { Accessor } from "solid-js";
import type { BufferSyncPresentation } from "../../engine/buffer-sync";
import { platformEnvironment } from "../../platform/environment";
import { createConnectionProgress } from "../../ui/connection-progress";
import { Line } from "../../ui/Line";

interface ConversationTitleProps {
  readonly class?: string | undefined;
  readonly sync: Accessor<BufferSyncPresentation>;
  readonly title: string;
}

export function ConversationTitle(props: ConversationTitleProps) {
  const platform = platformEnvironment();
  const progress = createConnectionProgress(() => props.sync().progressing, {
    interrupted: () => props.sync().interrupted,
    mode: "sweep",
    prefersReducedMotion: platform.prefersReducedMotion,
  });
  return (
    <h2
      aria-busy={progress.active() || undefined}
      class={props.class}
      data-connection-phase={
        progress.phase() === "idle" ? undefined : progress.phase()
      }
      data-connection-progress={progress.active() || undefined}
      data-connection-shimmer="true"
      data-connection-title="true"
      data-connection-visible={platform.pageVisible() || undefined}
      data-conversation-title="true"
      onAnimationEnd={progress.handleAnimationEnd}
      onAnimationIteration={progress.handleAnimationIteration}
    >
      <Line>{props.title}</Line>
    </h2>
  );
}
