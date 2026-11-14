import { createSignal, Match, Switch } from "solid-js";
import { t } from "../../strings";
import { openImageViewer } from "../image-viewer/image-viewer-request";
import styles from "./InlineImage.module.css";

interface NaturalSize {
  readonly height: number;
  readonly width: number;
}

type ImageState =
  | { readonly kind: "loading"; readonly size?: NaturalSize }
  | { readonly kind: "loaded"; readonly size: NaturalSize }
  | {
      readonly kind: "still";
      readonly size: NaturalSize;
      readonly frame: HTMLCanvasElement;
    }
  | { readonly kind: "failed" };

const animatedPath = /\.(?:gif|webp)$/iu;

// Virtualisation remounts rows; remembering each loaded size keeps a
// scrolled-back image at its final width instead of re-growing from 4:3.
const loadedSizes = new Map<string, NaturalSize>();

export function InlineImage(props: {
  readonly author: string;
  readonly onOpenExternal?: ((href: string) => void) | undefined;
  readonly presentation: "desktop" | "mobile";
  readonly time: number;
  readonly url: string;
}) {
  const still = prefersStill(props.url);
  const knownSize = loadedSizes.get(props.url);
  const [state, setState] = createSignal<ImageState>(
    knownSize === undefined
      ? { kind: "loading" }
      : still
        ? { kind: "loading", size: knownSize }
        : { kind: "loaded", size: knownSize },
  );
  const aspectStyle = () => {
    const current = state();
    return current.kind !== "failed" && current.size !== undefined
      ? {
          "--wl-inline-image-aspect": String(
            current.size.width / current.size.height,
          ),
        }
      : undefined;
  };
  const showLoaded = (image: HTMLImageElement) => {
    if (image.naturalWidth === 0 || image.naturalHeight === 0) {
      setState({ kind: "failed" });
      return;
    }
    const size = { height: image.naturalHeight, width: image.naturalWidth };
    loadedSizes.set(props.url, size);
    const frame = still ? firstFrame(image) : undefined;
    setState(
      frame === undefined
        ? { kind: "loaded", size }
        : { kind: "still", size, frame },
    );
  };
  const viewableSize = () => {
    const current = state();
    return current.kind === "loaded" || current.kind === "still"
      ? current.size
      : undefined;
  };
  const openViewer = (slot: HTMLElement): boolean => {
    const size = viewableSize();
    if (size === undefined) return false;
    openImageViewer({
      author: props.author,
      naturalHeight: size.height,
      naturalWidth: size.width,
      origin: slot,
      time: props.time,
      url: props.url,
    });
    return true;
  };
  const host = new URL(props.url).host;
  return (
    <a
      aria-label={
        viewableSize() === undefined
          ? t("messages.image.open", { host, nick: props.author })
          : t("messages.image.view", { nick: props.author })
      }
      class={styles.slot}
      data-inline-image={state().kind}
      data-presentation={props.presentation}
      draggable={false}
      href={props.url}
      onClick={(event) => {
        if (!opensNewTab(event) && openViewer(event.currentTarget)) {
          event.preventDefault();
          return;
        }
        if (props.onOpenExternal === undefined) return;
        event.preventDefault();
        props.onOpenExternal(props.url);
      }}
      onKeyDown={(event) => {
        if (event.key === " " && openViewer(event.currentTarget))
          event.preventDefault();
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

function opensNewTab(event: MouseEvent): boolean {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
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
