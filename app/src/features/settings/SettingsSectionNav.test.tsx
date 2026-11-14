import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { timeTokens } from "../../theme/theme-registry";
import { SettingsSectionNav } from "./SettingsSectionNav";

type Section = "appearance" | "notifications";

const sections = [
  {
    id: "appearance",
    label: "Appearance",
    labelId: "appearance-label",
    icon: () => <svg aria-hidden="true" />,
  },
  {
    id: "notifications",
    label: "Notifications",
    labelId: "notifications-label",
    icon: () => <svg aria-hidden="true" />,
  },
] as const;

function setup(rail: boolean) {
  const onSelect = vi.fn();
  const [current, setCurrent] = createSignal<Section>("appearance");
  const [expanded, setExpanded] = createSignal(false);
  const onExpandedChange = vi.fn(setExpanded);
  render(() => (
    <>
      <SettingsSectionNav
        current={current()}
        expanded={expanded()}
        onExpandedChange={onExpandedChange}
        onSelect={(id) => {
          onSelect(id);
          setCurrent(id);
        }}
        rail={rail}
        sections={sections}
      />
      <button type="button">Outside</button>
    </>
  ));
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  return { expanded, nav, onExpandedChange, onSelect };
}

describe("SettingsSectionNav", () => {
  afterEach(() => vi.useRealTimers());

  it("names icon-only rail items and marks the current section", () => {
    const { nav } = setup(true);
    const appearance = screen.getByRole("button", { name: "Appearance" });

    expect(nav).toHaveAttribute("data-rail");
    expect(appearance).toHaveAttribute("aria-current", "page");
    expect(appearance).toHaveAttribute("title", "Appearance");
    expect(
      screen.getByRole("button", { name: "Notifications" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("expands after the hover-intent delay and collapses when the pointer leaves", () => {
    vi.useFakeTimers();
    const { expanded, nav } = setup(true);

    fireEvent.pointerEnter(nav);
    vi.advanceTimersByTime(Number.parseFloat(timeTokens.railHoverIntent) - 1);
    expect(expanded()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(expanded()).toBe(true);
    expect(nav).toHaveAttribute("data-expanded");
    expect(
      screen.getByRole("button", { name: "Appearance" }),
    ).not.toHaveAttribute("title");

    fireEvent.pointerLeave(nav);
    expect(expanded()).toBe(false);
  });

  it("does not expand when the pointer only passes over", () => {
    vi.useFakeTimers();
    const { expanded, nav } = setup(true);

    fireEvent.pointerEnter(nav);
    fireEvent.pointerLeave(nav);
    vi.runAllTimers();

    expect(expanded()).toBe(false);
  });

  it("expands on keyboard focus and collapses when focus leaves", () => {
    const { expanded } = setup(true);

    screen.getByRole("button", { name: "Appearance" }).focus();
    expect(expanded()).toBe(true);
    screen.getByRole("button", { name: "Notifications" }).focus();
    expect(expanded()).toBe(true);
    screen.getByRole("button", { name: "Outside" }).focus();
    expect(expanded()).toBe(false);
  });

  it("switches sections in one click and collapses", () => {
    const { expanded, onSelect } = setup(true);
    const notifications = screen.getByRole("button", { name: "Notifications" });
    notifications.focus();

    fireEvent.click(notifications);

    expect(onSelect).toHaveBeenCalledWith("notifications");
    expect(notifications).toHaveAttribute("aria-current", "page");
    expect(expanded()).toBe(false);
  });

  it("stays a plain labelled list in a wide window", () => {
    vi.useFakeTimers();
    const { nav, onExpandedChange, onSelect } = setup(false);

    fireEvent.pointerEnter(nav);
    vi.runAllTimers();
    screen.getByRole("button", { name: "Appearance" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    fireEvent.pointerLeave(nav);
    screen.getByRole("button", { name: "Outside" }).focus();

    expect(onSelect).toHaveBeenCalledWith("notifications");
    expect(onExpandedChange).not.toHaveBeenCalled();
    expect(nav).not.toHaveAttribute("data-rail");
    expect(
      screen.getByRole("button", { name: "Appearance" }),
    ).not.toHaveAttribute("title");
  });
});
