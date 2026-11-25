import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { switchesOn } from "../../engine/app-settings-fixture";
import { SettingsModal } from "./SettingsModal";
import type { AccountControls } from "./settings-page-props";

function openSettings(account: AccountControls | undefined) {
  const onClose = vi.fn();
  render(() => (
    <SettingsModal
      account={account}
      onChange={() => {}}
      onClose={onClose}
      settings={{ theme: "system", message_density: "cozy", ...switchesOn }}
    />
  ));
  return { onClose };
}

function openAccount(onSignOut = vi.fn()) {
  const { onClose } = openSettings({
    membersSite: "https://members.weblounge.org",
    onSignOut,
  });
  fireEvent.click(screen.getByRole("button", { name: "Account" }));
  return { onClose, onSignOut };
}

describe("Account settings", () => {
  it("is offered only where the app signed in to a weblounge account", () => {
    openSettings(undefined);

    expect(screen.queryByRole("button", { name: "Account" })).toBeNull();
  });

  it("sends the member to the members site in a new window", () => {
    openAccount();

    const link = screen.getByRole("link", { name: "members.weblounge.org" });
    expect(link).toHaveAttribute("href", "https://members.weblounge.org");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAccessibleDescription(
      "Manage your account and invite people.",
    );
  });

  it("signs out only once the member confirms", () => {
    const { onSignOut } = openAccount();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Sign out" });
    expect(confirmation).toHaveTextContent(
      "Sign out of weblounge on this device?",
    );
    expect(onSignOut).not.toHaveBeenCalled();

    fireEvent.click(
      screen
        .getAllByRole("button", { name: "Sign out" })
        .find((button) => confirmation.contains(button)) as HTMLElement,
    );

    expect(onSignOut).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Signing out…" })).toBeDisabled();
  });

  it("keeps the member signed in when they cancel", async () => {
    const { onSignOut } = openAccount();
    const signOut = screen.getByRole("button", { name: "Sign out" });

    fireEvent.click(signOut);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onSignOut).not.toHaveBeenCalled();
    await waitFor(() => expect(signOut).toHaveFocus());
  });

  it("cancels on Escape and leaves Settings open", async () => {
    const { onClose, onSignOut } = openAccount();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Sign out" });
    const confirm = confirmation.querySelector("button") as HTMLButtonElement;
    await waitFor(() => expect(confirm).toHaveFocus());
    fireEvent.keyDown(confirm, { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onSignOut).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
