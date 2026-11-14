import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { MobileSettings, type MobileSettingsPage } from "./MobileSettings";

function setup(page: MobileSettingsPage) {
  const onBack = vi.fn();
  const onOpenPage = vi.fn();
  render(() => (
    <MobileSettings
      onBack={onBack}
      onChange={() => {}}
      onOpenPage={onOpenPage}
      page={page}
      settings={{ theme: "system", message_density: "comfortable" }}
    />
  ));
  return { onBack, onOpenPage };
}

describe("MobileSettings", () => {
  it("lists Appearance with its current values and opens its page", () => {
    const { onBack, onOpenPage } = setup("root");

    expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: /^Appearance\s*System · Comfortable$/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to chats" }));

    expect(onOpenPage).toHaveBeenCalledWith("appearance");
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("lists Appearance before the engine has answered", () => {
    render(() => (
      <MobileSettings
        onBack={() => {}}
        onChange={() => {}}
        onOpenPage={() => {}}
        page="root"
        settings={undefined}
      />
    ));

    expect(screen.getByRole("button", { name: "Appearance" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Settings" })).toBeVisible();
  });

  it("shows the Appearance controls in the phone layout", () => {
    const { onBack } = setup("appearance");

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeVisible();
    expect(
      screen
        .getByRole("radiogroup", { name: "Theme" })
        .closest("[data-settings-layout]"),
    ).toHaveAttribute("data-settings-layout", "phone");
    fireEvent.click(screen.getByRole("button", { name: "Back to Settings" }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
