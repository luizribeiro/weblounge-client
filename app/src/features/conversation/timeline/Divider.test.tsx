import { render, screen } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { Divider, type DividerContent } from "./Divider";

it.each<DividerContent>([
  { kind: "day", label: "Yesterday" },
  { kind: "gap", label: "Messages may be missing · 00:12 to 00:19" },
  { kind: "new", label: "New" },
])("renders the $kind line divider", (content) => {
  render(() => <Divider content={content} />);

  const divider = screen.getByRole("separator", {
    name: "label" in content ? content.label : "",
  });
  expect(divider).toHaveAttribute("data-divider-kind", content.kind);
});

it.each<DividerContent>([
  {
    kind: "history",
    title: "Beginning of #weblounge",
    caption: "Server history starts 3 Mar 2026",
  },
  { kind: "loading", title: "Loading older messages…" },
  {
    kind: "empty",
    title: "No messages yet",
    caption: "Messages you and iris send will appear here.",
  },
])("renders the centred $kind divider", (content) => {
  if (!("title" in content)) throw new Error("centred divider fixture");
  render(() => <Divider content={content} />);

  const divider = screen.getByRole("separator", { name: content.title });
  expect(divider).toHaveAttribute("data-divider-kind", content.kind);
  expect(divider.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  if (content.caption !== undefined)
    expect(divider).toHaveTextContent(content.caption);
});
