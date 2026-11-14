import { createSignal, Match, Switch } from "solid-js";
import { t } from "../../strings";
import styles from "./InlineImage.module.css";

type ImageState =
  | { readonly kind: "loading"; readonly aspect?: number }
  | { readonly kind: "loaded"; readonly aspect: number }
  | {
      readonly kind: "still";
      readonly aspect: number;
      readonly frame: HTMLCanvasElement;
    }
  | { readonly kind: "failed" };

const animatedPath = /\.(?:gif|webp)$/iu;

// Virtualisation remounts rows; remembering each loaded aspect keeps a
// scrolled-back image at its final width instead of re-growing from 4:3.
const loadedAspects = new Map<string, number>();

export function InlineImage(props: {
  readonly author: string;
  readonly onOpenExternal?: ((href: string) => void) | undefined;
  readonly presentation: "desktop" | "mobile";
  readonly url: string;
}) {
  const still = prefersStill(props.url);
  const knownAspect = loadedAspects.get(props.url);
  const [state, setState] = createSignal<ImageState>(
    knownAspect === undefined
      ? { kind: "loading" }
      : still
        ? { kind: "loading", aspect: knownAspect }
        : { kind: "loaded", aspect: knownAspect },
  );
  const aspectStyle = () => {
    const current = state();
    return current.kind !== "failed" && current.aspect !== undefined
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
    const frame = still ? firstFrame(image) : undefined;
    setState(
      frame === undefined
        ? { kind: "loaded", aspect }
        : { kind: "still", aspect, frame },
    );
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
      <Switch
        fallback={
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
        }
      >
        <Match when={state().kind === "failed"}>
          <span class={styles.failure}>
            <span>
              {t("messages.image.failed")} ·{" "}
              <span class={styles.openLink}>
                {t("messages.image.open_link")}
              </span>
            </span>
          </span>
        </Match>
        <Match when={stillFrame(state())} keyed>
          {(frame) => frame}
        </Match>
      </Switch>
    </a>
  );
}

function stillFrame(state: ImageState): HTMLCanvasElement | undefined {
  return state.kind === "still" ? state.frame : undefined;
}

function prefersStill(url: string): boolean {
  return (
    animatedPath.test(new URL(url).pathname) &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

// Drawing a cross-origin image only taints the canvas, which is never read
// back, so a still frame needs neither CORS nor a proxy.
function firstFrame(image: HTMLImageElement): HTMLCanvasElement | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  context.drawImage(image, 0, 0);
  canvas.className = styles.image ?? "";
  canvas.dataset.loaded = "true";
  return canvas;
}
