import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import {
  composerGeometryChangeEvent,
  composerGeometryWillChangeEvent,
} from "./geometry";
import type { ReplyDraft } from "./reply-drafts";

const parent: ReplyDraft = {
  messageId: 12,
  author: "bruno",
  nickColorIndex: 6,
  text: "does the relay see plaintext?",
};

beforeEach(() => sessionStorage.clear());

function renderReplying(
  onSend: (text: string, replyTo?: number) => Promise<boolean>,
) {
  const [reply, setReply] = createSignal<ReplyDraft | undefined>(parent);
  const cancel = vi.fn((draft: ReplyDraft) => {
    if (reply() === draft) setReply(undefined);
  });
  render(() => (
    <Composer
      bufferId={1}
      bufferTitle="#papo"
      draftKey="test:#papo"
      onCancelReply={cancel}
      onSend={onSend}
      reply={reply()}
    />
  ));
  return { cancel, input: screen.getByRole("textbox"), setReply };
}

function type(input: HTMLElement, value: string) {
  fireEvent.input(input, { target: { value } });
}

it("names the parent and sends the next message threaded under it", async () => {
  const onSend = vi.fn(async () => true);
  const { cancel, input } = renderReplying(onSend);

  expect(
    screen.getByText("Replying to").closest("[data-reply-bar]"),
  ).toHaveTextContent("Replying to bruno does the relay see plaintext?");
  expect(input).toHaveAttribute("placeholder", "Reply to bruno");
  type(input, "only ciphertext");
  fireEvent.keyDown(input, { key: "Enter" });

  expect(onSend).toHaveBeenCalledWith("only ciphertext", 12);
  await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  expect(document.querySelector("[data-reply-bar]")).toBeNull();
  expect(input).toHaveAttribute("placeholder", "Message #papo");
});

it("clears the bar after any successful send, a command included", async () => {
  const onSend = vi.fn(async () => true);
  const { cancel, input } = renderReplying(onSend);

  type(input, "/me waves");
  fireEvent.keyDown(input, { key: "Enter" });

  expect(onSend).toHaveBeenCalledWith("/me waves", 12);
  await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});

it("keeps the bar when the send fails", async () => {
  let refuse: ((accepted: boolean) => void) | undefined;
  const onSend = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        refuse = resolve;
      }),
  );
  const { cancel, input } = renderReplying(onSend);

  type(input, "only ciphertext");
  fireEvent.keyDown(input, { key: "Enter" });
  refuse?.(false);

  await waitFor(() => expect(input).toHaveValue("only ciphertext"));
  expect(cancel).not.toHaveBeenCalled();
  expect(document.querySelector("[data-reply-bar]")).not.toBeNull();
});

it("keeps a newer reply started while the send was in flight", async () => {
  let accept: ((accepted: boolean) => void) | undefined;
  const onSend = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        accept = resolve;
      }),
  );
  const { cancel, input, setReply } = renderReplying(onSend);

  type(input, "only ciphertext");
  fireEvent.keyDown(input, { key: "Enter" });
  setReply({ ...parent, messageId: 13, author: "ana" });
  accept?.(true);

  await waitFor(() => expect(input).toHaveValue(""));
  expect(cancel).toHaveBeenCalledWith(parent);
  expect(input).toHaveAttribute("placeholder", "Reply to ana");
});

it("cancels with Escape or the × and keeps the typed text", () => {
  const { cancel, input, setReply } = renderReplying(async () => true);

  type(input, "half a thought");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(cancel).toHaveBeenCalledOnce();
  expect(input).toHaveValue("half a thought");

  setReply(parent);
  fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));
  expect(cancel).toHaveBeenCalledTimes(2);
  expect(document.querySelector("[data-reply-bar]")).toBeNull();
});

it("announces the bar's geometry change around it appearing", () => {
  const { input, setReply } = renderReplying(async () => true);
  const seen: string[] = [];
  const record = (event: Event) =>
    seen.push(
      `${event.type}:${document.querySelector("[data-reply-bar]") !== null}`,
    );
  input.addEventListener(composerGeometryWillChangeEvent, record);
  input.addEventListener(composerGeometryChangeEvent, record);

  setReply(undefined);
  setReply(parent);

  expect(seen).toEqual([
    `${composerGeometryWillChangeEvent}:true`,
    `${composerGeometryChangeEvent}:false`,
    `${composerGeometryWillChangeEvent}:false`,
    `${composerGeometryChangeEvent}:true`,
  ]);
});

it("focuses the field each time a reply starts, to the same message too", () => {
  const { input, setReply } = renderReplying(async () => true);
  input.blur();

  setReply({ ...parent });
  expect(document.activeElement).toBe(input);
  input.blur();
  setReply({ ...parent, messageId: 20 });
  expect(document.activeElement).toBe(input);
});
