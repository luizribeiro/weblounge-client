import { expect, it } from "vitest";
import {
  desktopPanelBoundary,
  membersDockedWindowWidth,
  membersInlinePaneWidth,
} from "./desktop-panel-widths";

it("keeps the sidebar inline down to the sidebar beside a minimum conversation", () => {
  expect(desktopPanelBoundary).toBe(704);
});

it("docks members in a pane down to the column beside a minimum conversation", () => {
  expect(membersInlinePaneWidth).toBe(712);
});

it("undocks members beside the sidebar before the sidebar collapses", () => {
  expect(membersDockedWindowWidth).toBe(936);
  expect(membersDockedWindowWidth).toBeGreaterThan(desktopPanelBoundary);
});
