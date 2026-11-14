import { Show } from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "../../strings";
import { ConfirmationDialog } from "../../ui/ConfirmationDialog";
import styles from "../conversation/SimpleComposer.module.css";
import type { AttachmentController } from "./attachment-controller";
import { InlineConfirmation } from "./InlineConfirmation";

interface UploadOverlaysProps {
  readonly attachments: AttachmentController;
  readonly unavailable: boolean;
  readonly onSettled: () => void;
}

/** The no-uploads note, the replace question (U8) and the password-release dialog (U1). */
export function UploadOverlays(props: UploadOverlaysProps) {
  return (
    <>
      {props.unavailable && (
        <p class={styles.uploadNote} role="status">
          {t("upload.unavailable")}
        </p>
      )}
      {props.attachments.pendingReplacement() !== undefined && (
        <InlineConfirmation
          action={t("upload.replace_action")}
          label={t("upload.replace")}
          message={t("upload.replace")}
          onCancel={() => props.attachments.cancelReplacement()}
          onConfirm={() => props.attachments.confirmReplacement()}
        />
      )}
      <Show when={props.attachments.pendingApproval()}>
        {(approval) => (
          <Portal>
            <ConfirmationDialog
              action={t("upload.approval_action")}
              explanation={t("upload.approval_explanation")}
              label={t("upload.approval_label", { host: approval().host })}
              message={t("upload.approval_title", { host: approval().host })}
              onCancel={() => {
                approval().answer({ allow: false, remember: false });
                props.onSettled();
              }}
              onConfirm={(remember) => {
                approval().answer({ allow: true, remember });
                props.onSettled();
              }}
              remember={t("upload.approval_remember")}
            />
          </Portal>
        )}
      </Show>
    </>
  );
}
