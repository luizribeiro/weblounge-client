import { createSignal } from "solid-js";
export interface ViewerImage {
  readonly naturalHeight: number;
  readonly naturalWidth: number;
  readonly origin: HTMLElement;
  readonly url: string;
}

export interface ImageViewerRequest extends ViewerImage {
  readonly author: string;
  readonly time: number;
}

const [request, setRequest] = createSignal<ImageViewerRequest>();

export const currentImageViewerRequest = request;

export function openImageViewer(next: ImageViewerRequest): void {
  setRequest((current) => current ?? next);
}

export function closeImageViewer(): void {
  setRequest(undefined);
}
