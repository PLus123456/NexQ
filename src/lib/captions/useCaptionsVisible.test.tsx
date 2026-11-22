import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  visible: false,
  handler: null as ((event: { payload: { visible: boolean } }) => void) | null,
  stopped: 0,
}));

vi.mock("./window", () => ({
  CAPTIONS_VISIBILITY_EVENT: "nexq:captions_visibility",
  isCaptionsVisible: async () => state.visible,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, handler: (event: { payload: { visible: boolean } }) => void) => {
    state.handler = handler;
    return () => {
      state.stopped += 1;
    };
  },
}));

import { useCaptionsVisible } from "./useCaptionsVisible";

beforeEach(() => {
  state.visible = false;
  state.handler = null;
  state.stopped = 0;
});

describe("useCaptionsVisible", () => {
  it("starts from what the window says", async () => {
    state.visible = true;
    const { result } = renderHook(() => useCaptionsVisible());
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("follows the announced changes and stops listening when unmounted", async () => {
    const { result, unmount } = renderHook(() => useCaptionsVisible());
    await waitFor(() => expect(state.handler).not.toBeNull());
    act(() => state.handler?.({ payload: { visible: true } }));
    expect(result.current).toBe(true);
    act(() => state.handler?.({ payload: { visible: false } }));
    expect(result.current).toBe(false);
    unmount();
    expect(state.stopped).toBe(1);
  });
});
