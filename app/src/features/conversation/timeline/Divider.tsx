import { Match, Switch } from "solid-js";
import { EventIcon } from "../../../ui/icons/EventIcon";
import styles from "./Divider.module.css";

export type DividerContent =
  | { readonly kind: "day" | "gap" | "new"; readonly label: string }
  | {
      readonly kind: "empty" | "history" | "loading";
      readonly caption?: string | undefined;
      readonly title: string;
    };

export function Divider(props: { readonly content: DividerContent }) {
  const line = () =>
    props.content.kind === "day" ||
    props.content.kind === "gap" ||
    props.content.kind === "new"
      ? props.content
      : undefined;
  const centred = () =>
    props.content.kind === "empty" ||
    props.content.kind === "history" ||
    props.content.kind === "loading"
      ? props.content
      : undefined;
  return (
    <Switch>
      <Match when={line()} keyed>
        {(content) => (
          // biome-ignore lint/a11y/useSemanticElements: the labelled separator contains its visible label
          <div
            aria-label={content.label}
            class={styles.line}
            data-day-divider={content.kind === "day" || undefined}
            data-divider-kind={content.kind}
            data-gap-row={content.kind === "gap" || undefined}
            data-new-line={content.kind === "new" || undefined}
            role="separator"
          >
            <span>{content.label}</span>
          </div>
        )}
      </Match>
      <Match when={centred()} keyed>
        {(content) => (
          // biome-ignore lint/a11y/useSemanticElements: the labelled separator contains an icon and caption
          <div
            aria-label={content.title}
            class={styles.centred}
            data-divider-kind={content.kind}
            data-empty-row={content.kind === "empty" || undefined}
            data-history-edge={
              content.kind === "history" || content.kind === "loading"
                ? "true"
                : undefined
            }
            role="separator"
          >
            <EventIcon
              class={`${styles.icon} ${
                content.kind === "loading" ? styles.loadingIcon : ""
              }`}
              icon={
                content.kind === "history"
                  ? "flag"
                  : content.kind === "loading"
                    ? "loader"
                    : "chat"
              }
            />
            <span class={styles.title}>{content.title}</span>
            {content.caption !== undefined && (
              <span class={styles.caption}>{content.caption}</span>
            )}
          </div>
        )}
      </Match>
    </Switch>
  );
}
