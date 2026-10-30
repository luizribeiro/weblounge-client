export function installPageZoomGuard(document: Document): () => void {
  const preventPageZoom = (event: Event) => event.preventDefault();
  const options: AddEventListenerOptions = { passive: false };
  document.addEventListener("gesturestart", preventPageZoom, options);
  document.addEventListener("gesturechange", preventPageZoom, options);
  return () => {
    document.removeEventListener("gesturestart", preventPageZoom);
    document.removeEventListener("gesturechange", preventPageZoom);
  };
}
