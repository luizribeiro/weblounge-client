import PhotoSwipe, { type PhotoSwipeOptions } from "photoswipe";
import "photoswipe/style.css";
import type { ViewerImage } from "./image-viewer-request";
import type { ViewerCommand } from "./viewer-keys";
import {
  clampZoom,
  maxZoom,
  secondaryZoom,
  steppedZoom,
  tokenMilliseconds,
  type ZoomRange,
} from "./viewer-zoom";

export interface PhotoSwipeViewer {
  readonly close: () => void;
  readonly destroy: () => void;
  readonly run: (command: ViewerCommand) => void;
}

interface GestureEvent extends UIEvent {
  readonly clientX: number;
  readonly clientY: number;
  readonly scale: number;
}

export function openPhotoSwipe(options: {
  readonly fitBox: HTMLElement;
  readonly host: HTMLElement;
  readonly image: ViewerImage;
  readonly onClosing: () => void;
  readonly onDestroyed: () => void;
}): PhotoSwipeViewer {
  const pswp = new PhotoSwipe({
    ...motionOptions(),
    ...disabledChrome,
    appendToEl: options.host,
    bgClickAction: "close",
    bgOpacity: 1,
    dataSource: [
      {
        element: options.image.origin,
        height: options.image.naturalHeight,
        src: options.image.url,
        thumbCropped: true,
        width: options.image.naturalWidth,
      },
    ],
    doubleTapAction: "zoom",
    imageClickAction: false,
    maxZoomLevel: (levels) => maxZoom(levels.fit),
    paddingFn: (viewport) => fitBoxPadding(options.fitBox, viewport),
    secondaryZoomLevel: (levels) => secondaryZoom(levels.fit),
    tapAction: (_point, event) => {
      if (isBackdrop(event.target)) pswp.close();
    },
    wheelToZoom: true,
  });
  pswp.on("uiRegister", () => {
    pswp.ui?.uiElementsData.splice(0);
  });
  pswp.addFilter("thumbEl", () => options.image.origin);
  pswp.on("close", () => {
    if (!options.image.origin.isConnected)
      pswp.options.showHideAnimationType = "fade";
  });
  pswp.addFilter("isKeepingPlaceholder", () => true);
  pswp.on("contentLoadImage", ({ content }) => {
    if (content.element instanceof HTMLImageElement)
      content.element.draggable = false;
  });
  let destroyed = false;
  pswp.on("close", options.onClosing);
  pswp.on("destroy", () => {
    destroyed = true;
    options.onDestroyed();
  });
  pswp.init();
  describeAsSingleImage(pswp);
  const stopDoubleClick = listenForDoubleClick(pswp);
  const stopGestures = listenForGestureZoom(pswp);
  pswp.on("destroy", () => {
    stopDoubleClick();
    stopGestures();
  });

  return {
    close: () => pswp.close(),
    destroy: () => {
      if (!destroyed) pswp.destroy();
    },
    run: (command) => runCommand(pswp, command),
  };
}

const disabledChrome = {
  arrowKeys: false,
  escKey: false,
  returnFocus: false,
  trapFocus: false,
} satisfies PhotoSwipeOptions;

function motionOptions(): PhotoSwipeOptions {
  const tokens = getComputedStyle(document.documentElement);
  const token = (name: string) => tokens.getPropertyValue(name).trim();
  return {
    easing: token("--wl-motion-push-curve"),
    hideAnimationDuration: tokenMilliseconds(token("--wl-motion-pop")),
    showAnimationDuration: tokenMilliseconds(token("--wl-motion-push-in")),
    zoomAnimationDuration: tokenMilliseconds(token("--wl-motion-push-in")),
  };
}

export function fitBoxPadding(
  fitBox: HTMLElement,
  viewport: { readonly x: number; readonly y: number },
) {
  const box = fitBox.getBoundingClientRect();
  return {
    bottom: Math.max(0, viewport.y - box.bottom),
    left: Math.max(0, box.left),
    right: Math.max(0, viewport.x - box.right),
    top: Math.max(0, box.top),
  };
}

export function isBackdrop(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.classList.contains("pswp__item") ||
      target.classList.contains("pswp__zoom-wrap"))
  );
}

// PhotoSwipe's own dialog and carousel roles would nest inside our dialog.
function describeAsSingleImage(pswp: PhotoSwipe): void {
  pswp.element?.removeAttribute("role");
  pswp.element?.removeAttribute("tabindex");
  pswp.scrollWrap?.removeAttribute("aria-roledescription");
  for (const holder of pswp.mainScroll.itemHolders) {
    holder.el.removeAttribute("role");
    holder.el.removeAttribute("aria-roledescription");
  }
}

function zoomRange(pswp: PhotoSwipe): ZoomRange | undefined {
  const slide = pswp.currSlide;
  if (slide === undefined) return undefined;
  return { fit: slide.zoomLevels.initial, max: slide.zoomLevels.max };
}

export function runCommand(pswp: PhotoSwipe, command: ViewerCommand): void {
  const slide = pswp.currSlide;
  const range = zoomRange(pswp);
  if (slide === undefined || range === undefined) return;
  switch (command.kind) {
    case "close":
      pswp.close();
      return;
    case "zoom":
      slide.zoomTo(steppedZoom(slide.currZoomLevel, command.direction, range));
      return;
    case "reset":
      slide.zoomTo(range.fit);
      return;
    case "pan":
      if (slide.currZoomLevel <= range.fit) return;
      slide.panTo(slide.pan.x + command.x, slide.pan.y + command.y);
      return;
  }
}

function listenForDoubleClick(pswp: PhotoSwipe): () => void {
  const element = pswp.element;
  if (element === undefined) return () => {};
  let pointerType = "mouse";
  const remember = (event: PointerEvent) => {
    pointerType = event.pointerType;
  };
  // PhotoSwipe already toggles on a touch double tap, which some browsers
  // follow with a synthetic dblclick.
  const toggle = (event: MouseEvent) => {
    if (pointerType !== "mouse" || !(event.target instanceof Element)) return;
    if (event.target.closest(".pswp__zoom-wrap") === null) return;
    pswp.currSlide?.toggleZoom({ x: event.clientX, y: event.clientY });
  };
  element.addEventListener("pointerdown", remember, true);
  element.addEventListener("dblclick", toggle);
  return () => {
    element.removeEventListener("pointerdown", remember, true);
    element.removeEventListener("dblclick", toggle);
  };
}

// Safari and WKWebView report trackpad pinch as gesture events rather than
// ctrl+wheel; touch pinch arrives as pointers, which PhotoSwipe handles.
function listenForGestureZoom(pswp: PhotoSwipe): () => void {
  const element = pswp.element;
  if (element === undefined) return () => {};
  let start: number | undefined;
  const begin = (event: Event) => {
    event.preventDefault();
    start = pswp.gestures.isMultitouch
      ? undefined
      : pswp.currSlide?.currZoomLevel;
  };
  const change = (event: Event) => {
    event.preventDefault();
    const range = zoomRange(pswp);
    if (start === undefined || range === undefined) return;
    const gesture = event as GestureEvent;
    pswp.currSlide?.zoomTo(
      clampZoom(start * gesture.scale, range),
      { x: gesture.clientX, y: gesture.clientY },
      0,
    );
  };
  const end = () => {
    start = undefined;
  };
  element.addEventListener("gesturestart", begin);
  element.addEventListener("gesturechange", change);
  element.addEventListener("gestureend", end);
  return () => {
    element.removeEventListener("gesturestart", begin);
    element.removeEventListener("gesturechange", change);
    element.removeEventListener("gestureend", end);
  };
}
