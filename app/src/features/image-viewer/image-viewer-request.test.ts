import { afterEach, expect, it } from "vitest";
import {
  closeImageViewer,
  currentImageViewerRequest,
  type ImageViewerRequest,
  openImageViewer,
} from "./image-viewer-request";

afterEach(closeImageViewer);

function request(url: string): ImageViewerRequest {
  return {
    author: "alice",
    naturalHeight: 480,
    naturalWidth: 640,
    origin: document.createElement("a"),
    time: Date.UTC(2026, 10, 13, 22, 1),
    url,
  };
}

it("keeps the open image while another open is requested", () => {
  const first = request("https://files.example.test/first.png");
  openImageViewer(first);
  openImageViewer(request("https://files.example.test/second.png"));

  expect(currentImageViewerRequest()).toBe(first);
});

it("opens the next image once the viewer has closed", () => {
  openImageViewer(request("https://files.example.test/first.png"));
  closeImageViewer();
  const next = request("https://files.example.test/next.png");
  openImageViewer(next);

  expect(currentImageViewerRequest()).toBe(next);
});
