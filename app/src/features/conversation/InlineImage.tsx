import { createSignal, Show } from "solid-js";
import { t } from "../../strings";
import styles from "./InlineImage.module.css";

type ImageState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly aspect: number }
  | { readonly kind: "failed" };

// Virtualisation remounts rows; remembering each loaded aspect keeps a
// scrolled-back image at its final width instead of re-growing from 4:3.
const loadedAspects = new Map<string, number>();

export function InlineImage(props: {
  readonly author: string;
  readonly onOpenExternal?: ((href: string) => void) | undefined;
  readonly presentation: "desktop" | "mobile";
  readonly url: string;
}) {
  const knownAspect = loadedAspects.get(props.url);
  const [state, setState] = createSignal<ImageState>(
    knownAspect === undefined
      ? { kind: "loading" }
      : { kind: "loaded", aspect: knownAspect },
  );
  const aspectStyle = () => {
    const current = state();
    return current.kind === "loaded"
      ? { "--wl-inline-image-aspect": String(current.aspect) }
      : undefined;
  };
  const showLoaded = (image: HTMLImageElement) => {
    if (image.naturalWidth === 0 || image.naturalHeight === 0) {
      setState({ kind: "failed" });
      return;
    }
    const aspect = image.naturalWidth / image.naturalHeight;
    loadedAspects.set(props.url, aspect);
    setState({ kind: "loaded", aspect });
  };
  const host = new URL(props.url).host;
  return (
    <a
      aria-label={t("messages.image.open", {
        host,
        nick: props.author,
      })}
      class={styles.slot}
      data-inline-image={state().kind}
      data-presentation={props.presentation}
      draggable={false}
      href={props.url}
      onClick={(event) => {
        if (props.onOpenExternal === undefined) return;
        event.preventDefault();
        props.onOpenExternal(props.url);
      }}
      rel="noopener noreferrer"
      style={aspectStyle()}
      target="_blank"
    >
      <Show
        when={state().kind !== "failed"}
        fallback={
          <span class={styles.failure}>
            <span>
              {t("messages.image.failed")} ·{" "}
              <span class={styles.openLink}>
                {t("messages.image.open_link")}
              </span>
            </span>
          </span>
        }
      >
        <img
          alt=""
          class={styles.image}
          data-loaded={state().kind === "loaded"}
          decoding="async"
          draggable={false}
          loading="lazy"
          onError={() => setState({ kind: "failed" })}
          onLoad={(event) => showLoaded(event.currentTarget)}
          src={props.url}
        />
      </Show>
    </a>
  );
}
