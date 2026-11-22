import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { JsonObjectField, ParamsFields } from "./ParamsFields";

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

const thinkingOptions = () =>
  Array.from((screen.getByLabelText("Thinking") as HTMLSelectElement).options).map((o) => o.textContent);

it("offers Auto, Off, Low and High for thinking, and never stores Auto", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const { rerender } = render(<ParamsFields idPrefix="p" value={{ temperature: 0.3 }} onChange={onChange} />);
  expect(screen.getByLabelText("Thinking")).toHaveValue("auto");
  expect(thinkingOptions()).toEqual(["Auto", "Off", "Low", "High"]);
  expect(
    screen.getByText("Off answers faster. Not every model supports it; NexQ Plus falls back automatically."),
  ).toBeInTheDocument();

  await user.selectOptions(screen.getByLabelText("Thinking"), "off");
  expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.3, thinking: "off" });

  // Back to Auto leaves nothing behind.
  rerender(<ParamsFields idPrefix="p" value={{ temperature: 0.3, thinking: "off" }} onChange={onChange} />);
  expect(screen.getByLabelText("Thinking")).toHaveValue("off");
  await user.selectOptions(screen.getByLabelText("Thinking"), "auto");
  expect(onChange).toHaveBeenLastCalledWith({ temperature: 0.3 });
});

it("names the setting a task route follows while its own is Auto", () => {
  // The connection says Off; a parent route in between says nothing.
  render(<ParamsFields idPrefix="p" value={{}} onChange={() => {}} inherited={[{ thinking: "off" }, { temperature: 0.2 }]} />);
  expect(screen.getByLabelText("Thinking")).toHaveValue("auto");
  expect(thinkingOptions()).toEqual(["Inherited: Off", "Off", "Low", "High"]);
});

it("says when a thinking key in the extra request body takes the setting's place", () => {
  const overridden = /An extra request body already sets “.+”, so this setting isn't applied\./;
  const view = render(<ParamsFields idPrefix="p" value={{ thinking: "off" }} onChange={() => {}} />);
  expect(screen.queryByText(overridden)).toBeNull();

  // In this level's own extra request body.
  view.rerender(<ParamsFields idPrefix="p" value={{ thinking: "off", extra_body: { reasoning_effort: "none" } }} onChange={() => {}} />);
  expect(screen.getByText("An extra request body already sets “reasoning_effort”, so this setting isn't applied.")).toBeInTheDocument();
  expect(screen.getByLabelText("Thinking")).toHaveAccessibleDescription(/already sets “reasoning_effort”/);
  view.unmount();

  // Set by a layer underneath (the connection), and removed again by the task's own body.
  const connection = { extra_body: { chat_template_kwargs: { enable_thinking: false } } };
  const task = render(<ParamsFields idPrefix="p" value={{}} onChange={() => {}} inherited={[connection]} />);
  expect(screen.getByText(/already sets “chat_template_kwargs\.enable_thinking”/)).toBeInTheDocument();
  task.rerender(
    <ParamsFields idPrefix="p" value={{ extra_body: { chat_template_kwargs: null } }} onChange={() => {}} inherited={[connection]} />,
  );
  expect(screen.queryByText(overridden)).toBeNull();
});

it("turns the setting off where it has no effect, and says why", () => {
  render(
    <ParamsFields
      idPrefix="p"
      value={{ thinking: "high", extra_body: { think: true } }}
      onChange={() => {}}
      thinkingUnusedHint="Not used with Claude (subscription): its Fast and Deep models have their own thinking switches."
    />,
  );
  expect(screen.getByLabelText("Thinking")).toBeDisabled();
  expect(screen.getByLabelText("Thinking")).toHaveAccessibleDescription(/^Not used with Claude \(subscription\)/);
  expect(screen.queryByText(/Off answers faster/)).toBeNull();
  expect(screen.queryByText(/already sets/)).toBeNull();
});
