import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionDetectionSettingsView } from "../../lib/questionDetection/types";

const ipc = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("../../lib/questionDetection/ipc", () => ({
  getQuestionDetectionSettings: ipc.get,
  setQuestionDetectionSettings: ipc.set,
  onQuestionDetectionSettingsChanged: ipc.listen,
}));

import { emptyView, mockConnection } from "../../lib/llm/testing/mockLlmBackend";
import { resetQuestionDetectionStoreForTests } from "../../stores/questionDetectionStore";
import { QuestionDetectionCard } from "./QuestionDetectionCard";

const connection = mockConnection({
  id: "local-detector",
  name: "Local Qwen",
  kind: "ollama",
  base_url: "http://localhost:11434",
  default_model: "qwen3:1.7b",
});
const configured = () => emptyView({
  connections: [connection],
  routing: {
    default: { target: { connection_id: connection.id, model: null }, params: {} },
    tasks: { question_detect: { target: { connection_id: connection.id, model: null }, params: {} } },
  },
});

let current: QuestionDetectionSettingsView;
let emit: (view: QuestionDetectionSettingsView) => void;

beforeEach(() => {
  resetQuestionDetectionStoreForTests();
  vi.clearAllMocks();
  current = {
    revision: 1,
    settings: { mode: "hybrid", confidence_threshold: 0.7, log_requests: false },
    effective_mode: "hybrid",
    fallback_reason: null,
  };
  ipc.get.mockImplementation(async () => ({ ...current }));
  ipc.set.mockImplementation(async (settings) => {
    current = { ...current, revision: current.revision + 1, settings, effective_mode: settings.mode };
    emit(current);
    return current;
  });
  ipc.listen.mockImplementation(async (handler) => { emit = handler; return () => {}; });
});

afterEach(cleanup);

describe("question detection settings", () => {
  it("switches between all three modes and keeps the chosen threshold", async () => {
    const user = userEvent.setup();
    render(<QuestionDetectionCard view={configured()} />);
    expect(await screen.findByRole("button", { name: "Rules + model confirmation (recommended)" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Rules only" }));
    await waitFor(() => expect(ipc.set).toHaveBeenLastCalledWith({ mode: "rules", confidence_threshold: 0.7, log_requests: false }));
    expect(screen.getByRole("spinbutton", { name: "Confidence threshold" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Model only" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Model only" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("spinbutton", { name: "Confidence threshold" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Rules + model confirmation (recommended)" }));
    await waitFor(() => expect(current.settings.mode).toBe("hybrid"));
  });

  it("shows rules fallback without an explicit route even when a default model is configured", async () => {
    const view = configured();
    view.routing.tasks = {};
    render(<QuestionDetectionCard view={view} />);
    expect(await screen.findByRole("status")).toHaveTextContent("This task does not inherit the default model");
  });

  it("shows fallback for a disabled connection", async () => {
    const view = configured();
    view.connections[0] = { ...view.connections[0], enabled: false };
    view.effective = {};
    render(<QuestionDetectionCard view={view} />);
    expect(await screen.findByRole("status")).toHaveTextContent("connection or model is unavailable");
  });

  it("shows fallback for an existing Claude subscription route", async () => {
    const view = configured();
    view.connections[0] = { ...view.connections[0], kind: "claude_cli" };
    // Even stale effective metadata must not make the unsupported route usable.
    render(<QuestionDetectionCard view={view} />);
    expect(await screen.findByRole("status")).toHaveTextContent("connection or model is unavailable");
  });

  it("saves confidence and logging preferences; detection logs start off", async () => {
    const user = userEvent.setup();
    render(<QuestionDetectionCard view={configured()} />);
    const log = await screen.findByRole("switch", { name: "Record question detection in AI call logs" });
    expect(log).toHaveAttribute("aria-checked", "false");
    const threshold = screen.getByRole("spinbutton", { name: "Confidence threshold" });
    fireEvent.change(threshold, { target: { value: "0.85" } });
    fireEvent.blur(threshold);
    await waitFor(() => expect(current.settings.confidence_threshold).toBe(0.85));
    await user.click(log);
    await waitFor(() => expect(current.settings.log_requests).toBe(true));
    expect(ipc.set).toHaveBeenLastCalledWith({ mode: "hybrid", confidence_threshold: 0.85, log_requests: true });
    fireEvent.change(threshold, { target: { value: "2" } });
    fireEvent.blur(threshold);
    expect(threshold).toHaveValue(0.85);
    expect(ipc.set).toHaveBeenCalledTimes(2);
  });

  it("follows changes from another window and ignores an older response", async () => {
    render(<QuestionDetectionCard view={configured()} />);
    await screen.findByRole("button", { name: "Model only" });
    act(() => emit({
      ...current,
      revision: 3,
      settings: { mode: "model", confidence_threshold: 0.9, log_requests: true },
      effective_mode: "model",
    }));
    expect(screen.getByRole("button", { name: "Model only" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("spinbutton", { name: "Confidence threshold" })).toHaveValue(0.9);
    act(() => emit(current));
    expect(screen.getByRole("button", { name: "Model only" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("shows runtime failure and clears it when a later model request succeeds", async () => {
    render(<QuestionDetectionCard view={configured()} />);
    await screen.findByRole("button", { name: "Model only" });
    act(() => emit({ ...current, revision: 2, effective_mode: "rules", fallback_reason: "timeout" }));
    expect(screen.getByRole("status")).toHaveTextContent("did not respond within 2.5 seconds");
    act(() => emit({ ...current, revision: 3 }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("refreshes availability after the routing configuration changes", async () => {
    const { rerender } = render(<QuestionDetectionCard view={configured()} />);
    await screen.findByRole("button", { name: "Model only" });
    current = { ...current, revision: 2, effective_mode: "rules", fallback_reason: "connection_unavailable" };
    rerender(<QuestionDetectionCard view={{ ...configured(), revision: 2 }} />);
    expect(await screen.findByRole("status")).toHaveTextContent("connection or model is unavailable");
    expect(ipc.get).toHaveBeenCalledTimes(2);
  });
});
