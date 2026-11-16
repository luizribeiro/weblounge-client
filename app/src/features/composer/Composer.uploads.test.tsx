import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  NetworkUploads,
  UploadOptions,
  UploadResult,
} from "../uploads/types";
import { Composer } from "./Composer";
import {
  composerGeometryChangeEvent,
  composerGeometryWillChangeEvent,
} from "./geometry";
import { fileCommand } from "./test-commands";

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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderComposer(
  uploads: NetworkUploads | undefined,
  bufferId: () => number = () => 2,
) {
  const onSend = vi.fn(async () => true);
  render(() => (
    <Composer
      bufferId={bufferId()}
      bufferTitle="#lounge"
      commandSpecs={[fileCommand]}
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

it("announces the chip's geometry change before and after it renders", () => {
  const { input } = renderComposer(new ControlledUploads());
  const seen: string[] = [];
  const record = (event: Event) =>
    seen.push(
      `${event.type}:${document.querySelector("[data-attachment-chip]") !== null}`,
    );
  input.addEventListener(composerGeometryWillChangeEvent, record);
  input.addEventListener(composerGeometryChangeEvent, record);

  pasteImage(input);
  fireEvent.click(screen.getByLabelText("Remove image"));

  expect(seen).toEqual([
    `${composerGeometryWillChangeEvent}:false`,
    `${composerGeometryChangeEvent}:true`,
    `${composerGeometryWillChangeEvent}:true`,
    `${composerGeometryChangeEvent}:false`,
  ]);
});

function pickerClicks() {
  return vi
    .spyOn(HTMLInputElement.prototype, "click")
    .mockImplementation(() => undefined);
}

function typeAndEnter(input: HTMLElement, value: string) {
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function choose(files: readonly File[]) {
  const picker = document.querySelector<HTMLInputElement>(
    "[data-image-picker]",
  );
  if (picker === null) throw new Error("no image picker");
  Object.defineProperty(picker, "files", { value: files, configurable: true });
  fireEvent.change(picker);
}

function pickImage() {
  choose([
    new File([new Uint8Array([0x89, 0x50, 0x4e])], "photo.png", {
      type: "image/png",
    }),
  ]);
}

it("opens the image picker on /file Enter, clears the text and attaches the pick", async () => {
  const clicks = pickerClicks();
  const uploads = new ControlledUploads();
  const { input, onSend } = renderComposer(uploads);
  typeAndEnter(input, "/file");

  expect(clicks).toHaveBeenCalledTimes(1);
  expect(clicks.mock.contexts[0]).toHaveProperty("accept", "image/*");
  expect(clicks.mock.contexts[0]).toHaveProperty("multiple", false);
  expect((input as HTMLTextAreaElement).value).toBe("");
  expect(onSend).not.toHaveBeenCalled();
  pickImage();
  await waitFor(() => expect(screen.getByText("Image · 3 B")).toBeTruthy());
  expect(uploads.calls).toEqual([]);
});

it("attaches a picked image the browser left untyped", async () => {
  pickerClicks();
  const { input } = renderComposer(new ControlledUploads());
  typeAndEnter(input, "/file");
  choose([
    new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      "landscape.png",
    ),
  ]);
  await waitFor(() => expect(screen.getByText("Image · 8 B")).toBeTruthy());
});

it("drops a pick still being read when the conversation changes", async () => {
  pickerClicks();
  const [bufferId, setBufferId] = createSignal(2);
  const { input } = renderComposer(new ControlledUploads(), bufferId);
  typeAndEnter(input, "/file");
  let release: (bytes: ArrayBuffer) => void = () => undefined;
  const slow = new File([], "landscape.png");
  slow.slice = () =>
    Object.assign(new Blob(), {
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          release = resolve;
        }),
    });
  choose([slow]);
  setBufferId(3);
  release(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer,
  );
  // A macrotask runs only after every microtask the pick's reading queued.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.querySelector("[data-attachment-chip]")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
});

it("notes a picked file that is not an image", async () => {
  pickerClicks();
  const { input } = renderComposer(new ControlledUploads());
  typeAndEnter(input, "/file");
  choose([new File(["%PDF-1.7\n"], "notes.pdf", { type: "application/pdf" })]);
  await waitFor(() =>
    expect(screen.getByText("Can’t read this image.")).toBeTruthy(),
  );
  expect(document.querySelector("[data-attachment-chip]")).toBeNull();
});

it("opens the picker from the Send button", () => {
  const clicks = pickerClicks();
  const { input, onSend } = renderComposer(new ControlledUploads());
  fireEvent.input(input, { target: { value: "/FILE " } });
  const [send] = screen.getAllByRole("button", { name: "Send" });
  if (send === undefined) throw new Error("no Send button");
  fireEvent.click(send);
  expect(clicks).toHaveBeenCalledTimes(1);
  expect(onSend).not.toHaveBeenCalled();
});

it("opens the picker once from a tap on the phone Send button", () => {
  const clicks = pickerClicks();
  const { input, onSend } = renderComposer(new ControlledUploads());
  fireEvent.input(input, { target: { value: "/file" } });
  const touchSend = document.querySelector(
    "[data-composer-send] [data-composer-send-visual]",
  )?.parentElement;
  if (touchSend == null) throw new Error("no touch Send button");
  fireEvent.touchEnd(touchSend);
  fireEvent.click(touchSend);
  expect(clicks).toHaveBeenCalledTimes(1);
  expect(onSend).not.toHaveBeenCalled();
});

it("keeps an earlier image when the picker is cancelled", () => {
  const clicks = pickerClicks();
  const { input } = renderComposer(new ControlledUploads());
  pasteImage(input);
  typeAndEnter(input, "/file");
  expect(clicks).toHaveBeenCalledTimes(1);
  choose([]);
  expect((input as HTMLTextAreaElement).value).toBe("");
  expect(screen.getByText("Image · 2 B")).toBeTruthy();
});

it("notes a network without uploads instead of opening the picker", () => {
  const clicks = pickerClicks();
  const { input, onSend } = renderComposer(undefined);
  typeAndEnter(input, "/file");
  expect(clicks).not.toHaveBeenCalled();
  expect(onSend).not.toHaveBeenCalled();
  expect((input as HTMLTextAreaElement).value).toBe("");
  expect(screen.getByText("This network doesn’t accept uploads.")).toBeTruthy();
});

it("sends /file with an argument on to the engine", () => {
  const clicks = pickerClicks();
  const { input, onSend } = renderComposer(new ControlledUploads());
  typeAndEnter(input, "/file holiday.png");
  expect(clicks).not.toHaveBeenCalled();
  expect(onSend).toHaveBeenCalledWith("/file holiday.png");
});
