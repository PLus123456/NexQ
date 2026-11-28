import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  onDragDropEvent: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: mocks.onDragDropEvent }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));

import { FileUpload } from "./FileUpload";
import { useConfigStore } from "../stores/configStore";
import { useContextStore } from "../stores/contextStore";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.onDragDropEvent.mockResolvedValue(() => {});
  mocks.invoke.mockImplementation(async (command: string, args?: { filePath: string }) => {
    if (command === "load_context_file") return JSON.stringify({ id: args?.filePath, file_path: args?.filePath });
    if (command === "get_token_budget") return "{}";
    throw new Error(`Unexpected command ${command}`);
  });
  useConfigStore.setState({ contextStrategy: "local_rag" });
  useContextStore.setState({ resources: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FileUpload", () => {
  it("opens the file picker once and delegates indexing to the upload command", async () => {
    mocks.open.mockResolvedValue(["/tmp/notes.md"]);
    render(<FileUpload />);
    fireEvent.click(screen.getByText("Browse Files"));
    expect(mocks.open).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.invoke.mock.calls).toEqual([
      ["load_context_file", { filePath: "/tmp/notes.md" }],
      ["get_token_budget"],
    ]));
  });

  it.each([
    ["Windows", 2],
    ["Macintosh", 1],
  ])("on %s, loads native paths using the webview's coordinate space", async (platform, scale) => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(platform);
    render(<FileUpload />);
    const button = screen.getByRole("button");
    const previous = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    const hitTest = vi.fn((x: number) => x < 100 ? button : document.body);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hitTest });
    vi.stubGlobal("devicePixelRatio", 2);
    try {
      const nativeDrop = mocks.onDragDropEvent.mock.calls[0][0];
      await act(async () => {
        nativeDrop({ payload: { type: "drop", paths: ["/tmp/ignored.txt"], position: { x: 150 * scale, y: 40 * scale } } });
        nativeDrop({ payload: { type: "drop", paths: ["/tmp/notes.md"], position: { x: 50 * scale, y: 40 * scale } } });
      });
      expect(hitTest).toHaveBeenLastCalledWith(50, 40);
      expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "load_context_file")).toEqual([
        ["load_context_file", { filePath: "/tmp/notes.md" }],
      ]);
    } finally {
      userAgent.mockRestore();
      if (previous) Object.defineProperty(document, "elementFromPoint", previous);
      else Reflect.deleteProperty(document, "elementFromPoint");
    }
  });
});
