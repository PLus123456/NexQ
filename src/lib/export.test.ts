import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveExportFile } from "./export";

const mocks = vi.hoisted(() => ({ save: vi.fn(), writeTextFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: mocks.writeTextFile }));
vi.mock("../stores/toastStore", () => ({ showToast: vi.fn() }));

describe("meeting export filenames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.save.mockResolvedValue("/tmp/export.md");
    mocks.writeTextFile.mockResolvedValue(undefined);
  });

  async function saveTitle(defaultName: string) {
    return saveExportFile({ defaultName, extension: "md", filterLabel: "Markdown", content: "正文" });
  }

  it("preserves Chinese and other Unicode titles in the save dialog", async () => {
    expect(await saveTitle("周会记录 Café 2026")).toBe(true);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "周会记录 Café 2026.md" }));
    expect(mocks.writeTextFile).toHaveBeenCalledWith("/tmp/export.md", "正文");
  });

  it("removes path separators and falls back only for empty titles", async () => {
    await saveTitle("../会议/记录\\总结:?");
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: "会议记录总结.md" }));
    await saveTitle(" /\\:*? ");
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: "meeting.md" }));
    await saveTitle("CON");
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: "_CON.md" }));
  });

  it("bounds multibyte titles without splitting a Unicode character", async () => {
    await saveTitle("会".repeat(200));
    const path = mocks.save.mock.calls[0][0].defaultPath;
    expect(new TextEncoder().encode(path).length).toBeLessThan(255);
    expect(path).toBe(`${"会".repeat(66)}.md`);
  });

  it("does not write when the save dialog is cancelled", async () => {
    mocks.save.mockResolvedValue(null);
    expect(await saveTitle("会议")).toBe(false);
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });
});
