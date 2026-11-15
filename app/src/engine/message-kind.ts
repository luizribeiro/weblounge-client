import type { MessageKind } from "./generated/MessageKind";
import type { Redaction } from "./generated/Redaction";

export function isRedacted(
  kind: MessageKind,
): kind is { readonly redacted: Redaction } {
  return typeof kind === "object" && "redacted" in kind;
}
