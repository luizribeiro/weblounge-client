import { render, screen } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { App } from "./App";

it("renders the application placeholder", () => {
  render(() => <App />);

  expect(
    screen.getByRole("heading", { name: "weblounge" }),
  ).toBeInTheDocument();
});
