import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Event } from "@tauri-apps/api/event";
import type { LocalSTTEngineInfo, ModelDownloadProgress } from "../lib/types";
import { useModelDownload } from "./useModelDownload";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  listLocalSTTEngines: vi.fn(),
  downloadLocalSTTModel: vi.fn(),
  cancelModelDownload: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../lib/ipc", () => ({
  listLocalSTTEngines: mocks.listLocalSTTEngines,
  downloadLocalSTTModel: mocks.downloadLocalSTTModel,
  cancelModelDownload: mocks.cancelModelDownload,
}));

const progress: ModelDownloadProgress = {
  engine: "sherpa_onnx",
  model_id: "sense-voice-small",
  status: "extracting",
  percent: 100,
  downloaded_bytes: 0,
  total_bytes: 0,
};
const key = `${progress.engine}:${progress.model_id}`;

function snapshot(progress: ModelDownloadProgress): LocalSTTEngineInfo[] {
  return [{
    engine: progress.engine,
    description: "",
    name: "Sherpa",
    models: [{
      id: progress.model_id,
      engine: progress.engine,
      name: "SenseVoice",
      size_bytes: 1,
      accuracy_rating: 1,
      speed_rating: 1,
      is_streaming: false,
      is_downloaded: false,
      download_progress: progress,
    }],
  }];
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

it("restores an active extraction and retains cancellation until the worker finishes", async () => {
  const unlisten = vi.fn();
  let receive: (event: Event<ModelDownloadProgress>) => void;
  mocks.listen.mockImplementation(async (_, callback) => {
    receive = callback;
    return unlisten;
  });
  mocks.listLocalSTTEngines.mockResolvedValue(snapshot(progress));
  const { result, unmount } = renderHook(() => useModelDownload(true));
  await waitFor(() => expect(result.current.downloads[key]?.status).toBe("extracting"));

  await act(async () => result.current.cancelDownload(progress.engine, progress.model_id));
  expect(mocks.cancelModelDownload).toHaveBeenCalledWith(progress.engine, progress.model_id);

  function emit(status: ModelDownloadProgress["status"]) {
    act(() => receive({
      event: "model_download_progress",
      id: 1,
      payload: { ...progress, status },
    }));
  }
  emit("cancelling");
  expect(result.current.downloads[key].status).toBe("cancelling");
  emit("cancelled");
  expect(result.current.downloads[key].status).toBe("cancelled");
  unmount();
  expect(unlisten).toHaveBeenCalledOnce();
});

it("disposes a listener whose registration resolves after unmount", async () => {
  const unlisten = vi.fn();
  let registered: (dispose: () => void) => void;
  mocks.listen.mockImplementation(() => new Promise((resolve) => {
    registered = resolve;
  }));

  const { unmount } = renderHook(() => useModelDownload(true));
  unmount();
  registered!(unlisten);

  await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  expect(mocks.listLocalSTTEngines).not.toHaveBeenCalled();
});
