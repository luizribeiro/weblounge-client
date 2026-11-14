import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  NetworkUploads,
  UploadOptions,
  UploadResult,
} from "../uploads/types";
import { Composer } from "./Composer";

const url = "https://files.weblounge.org/AbCdEfGhIjKlMnOpQrStUv.png";

class ControlledUploads implements NetworkUploads {
  readonly calls: { file: File; options: UploadOptions }[] = [];
  #finish: ((result: UploadResult) => void) | undefined;
  upload(file: File, options: UploadOptions) {
    this.calls.push({ file, options });
    return new Promise<UploadResult>((resolve) => {
      this.#finish = resolve;
    });
  }
  finish(result: UploadResult) {
    this.#finish?.(result);
  }
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderComposer(uploads: NetworkUploads | undefined) {
  const onSend = vi.fn(async () => true);
  render(() => (
    <Composer
      bufferId={2}
      bufferTitle="#lounge"
      commandSpecs={[]}
      draftKey="network:#lounge"
      onSend={onSend}
      uploads={uploads}
    />
  ));
  return { onSend, input: screen.getByLabelText("Message #lounge") };
}

function pasteImage(target: HTMLElement, text = "") {
  const file = new File([new Uint8Array([0x89, 0x50])], "image.png", {
    type: "image/png",
  });
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [file],
      items: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  target.dispatchEvent(event);
  return { file, event };
}

it("attaches a pasted image as a chip without uploading it", () => {
  const uploads = new ControlledUploads();
  const { input } = renderComposer(uploads);
  const { event } = pasteImage(input);

  expect(event.defaultPrevented).toBe(true);
  expect(screen.getByText("Image · 2 B")).toBeTruthy();
  expect(
    document.querySelector("[data-attachment-thumbnail]")?.getAttribute("src"),
  ).toBe("blob:preview");
  expect(uploads.calls).toEqual([]);
});

it("lets copied text paste through beside the image", () => {
  const { input } = renderComposer(new ControlledUploads());
  const { event } = pasteImage(input, "from a web page");
  expect(event.defaultPrevented).toBe(false);
  expect(screen.getByText("Image · 2 B")).toBeTruthy();
});

it("uploads on Enter, shows progress and busy Send, then sends caption and URL", async () => {
  const uploads = new ControlledUploads();
  const { input, onSend } = renderComposer(uploads);
  pasteImage(input);
  fireEvent.input(input, { target: { value: "look" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => expect(uploads.calls).toHaveLength(1));
  uploads.calls[0]?.options.onProgress?.(0.5);
  await waitFor(() =>
    expect(
      document
        .querySelector("[data-upload-progress]")
        ?.getAttribute("data-upload-progress"),
    ).toBe("0.5"),
  );
  for (const send of screen.getAllByRole("button", { name: "Send" }))
    expect(send.getAttribute("data-busy")).toBe("true");
  uploads.finish({ kind: "uploaded", url });

  await waitFor(() => expect(onSend).toHaveBeenCalledWith(`look ${url}`));
  await waitFor(() =>
    expect(document.querySelector("[data-attachment-chip]")).toBeNull(),
  );
  expect((input as HTMLTextAreaElement).value).toBe("");
});

it("shows a failure with Retry and keeps the text", async () => {
  const uploads = new ControlledUploads();
  const { input, onSend } = renderComposer(uploads);
  pasteImage(input);
  fireEvent.input(input, { target: { value: "caption" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(uploads.calls).toHaveLength(1));
  uploads.finish({ kind: "rate_limited" });

  await waitFor(() =>
    expect(screen.getByText("Too many uploads. Try again later.")).toBeTruthy(),
  );
  expect((input as HTMLTextAreaElement).value).toBe("caption");
  fireEvent.click(screen.getByText("Retry"));
  await waitFor(() => expect(uploads.calls).toHaveLength(2));
  expect(onSend).not.toHaveBeenCalled();
});

it("removes the attachment with × or Escape in an empty composer", () => {
  const { input } = renderComposer(new ControlledUploads());
  pasteImage(input);
  fireEvent.click(screen.getByLabelText("Remove image"));
  expect(document.querySelector("[data-attachment-chip]")).toBeNull();

  pasteImage(input);
  fireEvent.input(input, { target: { value: "x" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(document.querySelector("[data-attachment-chip]")).not.toBeNull();
  fireEvent.input(input, { target: { value: "" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(document.querySelector("[data-attachment-chip]")).toBeNull();
});

it("leaves the paste alone on a network without uploads", () => {
  const { input } = renderComposer(undefined);
  const { event } = pasteImage(input);
  expect(event.defaultPrevented).toBe(false);
  expect(screen.getByText("This network doesn’t accept uploads.")).toBeTruthy();
  expect(document.querySelector("[data-attachment-chip]")).toBeNull();
  fireEvent.input(input, { target: { value: "typing on" } });
  expect(screen.queryByText("This network doesn’t accept uploads.")).toBeNull();
});

it("asks before sending the password to another site and passes the answer", async () => {
  const uploads = new ControlledUploads();
  const { input } = renderComposer(uploads);
  pasteImage(input);
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(uploads.calls).toHaveLength(1));

  const answer = uploads.calls[0]?.options.confirm("files.elsewhere.test");
  await waitFor(() =>
    expect(
      screen.getByText("Send your password to files.elsewhere.test?"),
    ).toBeTruthy(),
  );
  fireEvent.click(screen.getByLabelText("Remember for this network"));
  fireEvent.click(screen.getByText("Upload"));
  await expect(answer).resolves.toEqual({ allow: true, remember: true });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
