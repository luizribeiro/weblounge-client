import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import type { BufferSyncPresentation } from "../../engine/buffer-sync";
import { ConversationTitle } from "./ConversationTitle";

it("finishes the shared fill pass when the buffer becomes current", () => {
  const [sync, setSync] = createSignal<BufferSyncPresentation>({
    interrupted: false,
    progressing: true,
  });
  render(() => <ConversationTitle sync={sync} title="#lounge" />);
  const heading = screen.getByRole("heading", { name: "#lounge" });

  expect(heading).toHaveAttribute("data-connection-phase", "loading");
  expect(heading).toHaveAttribute("aria-busy", "true");
  setSync({ interrupted: false, progressing: false });
  expect(heading).toHaveAttribute("data-connection-phase", "finishing");
  fireEvent.animationIteration(heading);
  expect(heading).toHaveAttribute("data-connection-phase", "filling");
  fireEvent.animationEnd(heading);
  expect(heading).not.toHaveAttribute("data-connection-progress");
  expect(heading).not.toHaveAttribute("aria-busy");
});
