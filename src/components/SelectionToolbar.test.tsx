import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranslationResult } from "../lib/types";

const translateText = vi.hoisted(() => vi.fn());
vi.mock("../lib/ipc", () => ({ translateText }));

import { SelectionToolbar } from "./SelectionToolbar";
import { useTranslationStore } from "../stores/translationStore";

let selection = "";

function select(text: string) {
  selection = text;
  fireEvent.mouseDown(document.body);
  fireEvent.mouseUp(document.body);
}

function result(text: string): TranslationResult {
  return { original_text: text, translated_text: `translated ${text}`, source_lang: "en", target_lang: "fr", provider: "DeepL" };
}

beforeEach(() => {
  translateText.mockReset();
  useTranslationStore.setState({ selectionToolbarEnabled: true, sourceLang: "auto", targetLang: "fr" });
  vi.spyOn(window, "getSelection").mockImplementation(() => ({
    rangeCount: 1,
    toString: () => selection,
    getRangeAt: () => ({ getBoundingClientRect: () => new DOMRect(100, 120, 50, 20) }),
  }) as unknown as Selection);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SelectionToolbar", () => {
  it("positions the fixed toolbar in viewport coordinates", () => {
    vi.stubGlobal("scrollX", 200);
    vi.stubGlobal("scrollY", 300);
    render(<SelectionToolbar />);
    select("first selection");
    const toolbar = screen.getByRole("button", { name: "Translate" }).closest(".fixed");
    expect(toolbar).toHaveStyle({ left: "125px", top: "112px" });
  });

  it("does not show an earlier result on a new selection", async () => {
    let resolveFirst: (value: TranslationResult) => void = () => {};
    translateText.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    translateText.mockResolvedValueOnce(result("second selection"));
    render(<SelectionToolbar />);
    select("first selection");
    fireEvent.click(screen.getByRole("button", { name: "Translate" }));
    select("second selection");
    await act(async () => resolveFirst(result("first selection")));
    expect(screen.queryByText("translated first selection")).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Translate" })));
    expect(screen.getByText("translated second selection")).toBeInTheDocument();
  });
});
