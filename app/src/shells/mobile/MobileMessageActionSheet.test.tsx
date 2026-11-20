import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { MessageProjection } from "../../engine/protocol";
import { MobileMessageActionSheet } from "./MobileMessageActionSheet";
import { messageSheetActions } from "./message-sheet-actions";

const message: MessageProjection = {
  id: 9,
  author: "bruno",
  text: "the relay only forwards ciphertext",
  kind: "text",
  bot: false,
  authorship: "other",
  nick_color_index: 3,
  highlighted: false,
  delivery: "received",
  local_send_id: null,
  server_ids: ["msg-9"],
  server_time_ms: 1_000,
  received_at_ms: 1_000,
  reactions: [
    {
      text: "👀",
      actors: [{ nick: "weblounge", mine: true }],
      mine: true,
    },
  ],
};

function renderSheet(react: ((reaction: string) => void) | undefined) {
  const copied: string[] = [];
  const dismiss = vi.fn();
  render(() => (
    <MobileMessageActionSheet
      actions={messageSheetActions(message, {
        copyText: (text) => copied.push(text),
      })}
      message={message}
      onDismiss={dismiss}
      onReact={react}
    />
  ));
  const dialog = screen.getByRole("dialog", {
    name: "Actions for bruno’s message",
  });
  return { copied, dialog, dismiss };
}

it("offers the six quick reactions, outlining yours, and reacts with one tap", async () => {
  const reacted: string[] = [];
  const { dialog, dismiss } = renderSheet((reaction) => reacted.push(reaction));
  await Promise.resolve();

  expect(dialog).toHaveTextContent("bruno the relay only forwards ciphertext");
  const quick = within(dialog)
    .getAllByRole("button", { name: /^React with / })
    .map((button) => button.textContent);
  expect(quick).toEqual(["👍", "❤️", "😂", "🎉", "👀", "✅"]);
  expect(
    within(dialog).getByRole("button", { name: "React with 👍" }),
  ).toHaveFocus();
  expect(
    within(dialog).getByRole("button", { name: "React with 👀" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(within(dialog).queryByRole("button", { name: "Reply" })).toBeNull();

  fireEvent.click(
    within(dialog).getByRole("button", { name: "React with 🎉" }),
  );

  expect(reacted).toEqual(["🎉"]);
  expect(dismiss).toHaveBeenCalledOnce();
});

it("swaps the action list for the searchable picker and adds only new reactions", async () => {
  const reacted: string[] = [];
  const { dialog, dismiss } = renderSheet((reaction) => reacted.push(reaction));
  const add = within(dialog).getByRole("button", { name: "Add reaction" });

  fireEvent.click(add);
  expect(add).toHaveAttribute("aria-expanded", "true");
  expect(
    within(dialog).queryByRole("button", { name: "Copy text" }),
  ).toBeNull();
  fireEvent.input(within(dialog).getByPlaceholderText("Search emoji"), {
    target: { value: "rocket" },
  });
  fireEvent.click(
    await within(dialog).findByRole("button", { name: "rocket" }),
  );

  expect(reacted).toEqual(["🚀"]);
  expect(dismiss).toHaveBeenCalledOnce();
});

it("closes without unreacting when the picker's choice is already yours", async () => {
  const reacted: string[] = [];
  const { dialog, dismiss } = renderSheet((reaction) => reacted.push(reaction));

  fireEvent.click(within(dialog).getByRole("button", { name: "Add reaction" }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "eyes" }));

  expect(reacted).toEqual([]);
  expect(dismiss).toHaveBeenCalledOnce();
});

it("leaves out reaction controls without the capability but still copies the text", async () => {
  const { copied, dialog, dismiss } = renderSheet(undefined);
  await Promise.resolve();

  expect(
    within(dialog).queryByRole("button", { name: /^React with / }),
  ).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "Add reaction" }),
  ).toBeNull();
  const copy = within(dialog).getByRole("button", { name: "Copy text" });
  expect(copy).toHaveFocus();
  fireEvent.click(copy);

  expect(copied).toEqual(["the relay only forwards ciphertext"]);
  expect(dismiss).toHaveBeenCalledOnce();
});

it("lists Delete as a danger action only when the message can be deleted", () => {
  const deleted = vi.fn();
  render(() => (
    <MobileMessageActionSheet
      actions={messageSheetActions(
        { ...message, authorship: "own" },
        { copyText: () => undefined, delete: deleted },
      )}
      message={message}
      onDismiss={() => undefined}
      onReact={undefined}
    />
  ));
  const button = screen.getByRole("button", { name: "Delete message" });

  expect(button).toHaveAttribute("data-tone", "danger");
  fireEvent.click(button);
  expect(deleted).toHaveBeenCalledOnce();
  expect(
    messageSheetActions(message, { copyText: () => undefined }).map(
      (action) => action.id,
    ),
  ).toEqual(["copy-text"]);
});
