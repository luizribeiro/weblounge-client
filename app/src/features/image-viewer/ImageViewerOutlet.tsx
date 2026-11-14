import { lazy, Show, Suspense } from "solid-js";
import {
  closeImageViewer,
  currentImageViewerRequest,
} from "./image-viewer-request";

const ImageViewer = lazy(() => import("./ImageViewer"));

export function ImageViewerOutlet() {
  return (
    <Show when={currentImageViewerRequest()} keyed>
      {(request) => (
        <Suspense>
          <ImageViewer onClosed={closeImageViewer} request={request} />
        </Suspense>
      )}
    </Show>
  );
}
