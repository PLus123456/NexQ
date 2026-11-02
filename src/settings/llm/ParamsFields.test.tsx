import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { JsonObjectField } from "./ParamsFields";

afterEach(cleanup);

it("shows vendor thinking syntax without writing potentially unsupported parameters to requests", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<JsonObjectField id="body" value={{ seed: 7 }} onChange={onChange} disableThinking={{ reasoning_effort: "none" }} />);
  await user.click(screen.getByRole("button", { name: "View thinking parameter example" }));
  expect(screen.getByText(/Models with mandatory reasoning may reject off\/low values/)).toBeInTheDocument();
  expect(screen.getByText(/"reasoning_effort": "none"/)).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue('{\n  "seed": 7\n}');
  expect(onChange).not.toHaveBeenCalled();
});

it("preserves manually entered request parameters when the example is shown", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<JsonObjectField id="body" value={null} onChange={onChange} disableThinking={{ thinking: { type: "disabled" } }} />);
  const input = screen.getByRole("textbox");
  await user.click(input);
  await user.paste('{"seed": 12}');
  expect(onChange).toHaveBeenLastCalledWith({ seed: 12 });
  onChange.mockClear();
  await user.click(screen.getByRole("button", { name: "View thinking parameter example" }));
  expect(input).toHaveValue('{"seed": 12}');
  expect(onChange).not.toHaveBeenCalled();
});
