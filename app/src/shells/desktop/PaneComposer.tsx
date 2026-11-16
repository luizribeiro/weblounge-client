import type { BufferProjection } from "../../engine/protocol";
import { Composer } from "../../features/composer/Composer";
import { directIdentityBlocked } from "../../features/conversation/DirectIdentityBanner";
import type { DesktopPaneProps } from "./DesktopPane";

export interface PaneComposerProps extends DesktopPaneProps {
  readonly bufferId: number;
  readonly onSelectLast: () => void;
}

export function PaneComposer(props: PaneComposerProps) {
  const buffer = () =>
    props.buffer?.id === props.bufferId ? props.buffer : undefined;
  return (
    <Composer
      bufferId={props.bufferId}
      bufferKind={buffer()?.kind}
      bufferTitle={buffer()?.title ?? ""}
      commandSpecs={props.commandSpecs}
      draftKey={buffer()?.draft_key ?? ""}
      completion={
        props.completion?.buffer_id === props.bufferId
          ? props.completion
          : undefined
      }
      disabled={composerDisabled(buffer())}
      focusOnMount={props.focusComposerOnMount}
      typers={props.typers?.get(props.bufferId)}
      uploads={
        props.network === undefined
          ? undefined
          : props.uploadsFor?.(props.network)
      }
      onRequestCandidates={(input, cursor, explicit) =>
        props.onRequestCompletion(props.bufferId, input, cursor, explicit)
      }
      onSelectLast={props.onSelectLast}
      onSend={(text) => {
        const current = buffer();
        return current === undefined
          ? Promise.resolve(false)
          : props.onSendText(current, text);
      }}
    />
  );
}

function composerDisabled(buffer: BufferProjection | undefined): boolean {
  return (
    buffer?.kind === "server" ||
    buffer?.channel_status === "kicked" ||
    buffer?.available === false ||
    (buffer !== undefined && directIdentityBlocked(buffer))
  );
}
