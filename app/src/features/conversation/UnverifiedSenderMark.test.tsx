import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { UnverifiedSender } from "../../engine/protocol";
import { t } from "../../strings";
import { UnverifiedSenderMark } from "./UnverifiedSenderMark";

const reasons: readonly UnverifiedSender[] = [
  "no_account",
  "unproven_account",
  "different_account",
  "cannot_verify",
  "notification_mismatch",
];

describe("unverified sender mark", () => {
  it("renders nothing for a verified sender", () => {
    render(() => (
      <UnverifiedSenderMark presentation="desktop" reason={undefined} />
    ));

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("describes itself with a hover hint on desktop", () => {
    render(() => (
      <UnverifiedSenderMark presentation="desktop" reason="no_account" />
    ));

    expect(
      screen.getByRole("button", { name: "Unverified sender" }),
    ).toHaveAccessibleDescription("Unverified sender. Click to see why.");
  });

  it("explains each reason in its own words", () => {
    const explanations = reasons.map((reason) =>
      t(`messages.unverified_sender.${reason}`),
    );

    expect(new Set(explanations).size).toBe(reasons.length);
  });

  it("opens the explanation on desktop and closes it with Escape", async () => {
    render(() => (
      <UnverifiedSenderMark presentation="desktop" reason="different_account" />
    ));
    const mark = screen.getByRole("button", { name: "Unverified sender" });

    fireEvent.click(mark);
    const dialog = screen.getByRole("dialog", { name: "Unverified sender" });
    expect(dialog).toHaveTextContent(
      t("messages.unverified_sender.different_account"),
    );
    expect(mark).toHaveAttribute("aria-expanded", "true");
    expect(dialog).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mark).toHaveFocus();
  });

  it("opens the explanation as a sheet on the phone", () => {
    render(() => (
      <UnverifiedSenderMark presentation="mobile" reason="no_account" />
    ));

    fireEvent.click(screen.getByRole("button", { name: "Unverified sender" }));

    expect(
      screen.getByRole("dialog", { name: "Unverified sender" }),
    ).toHaveTextContent(t("messages.unverified_sender.no_account"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
