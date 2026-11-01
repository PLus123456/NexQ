import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({ open: vi.fn(async (_url: string) => {}) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shell.open }));

import { UpdateReadyToast } from "./UpdateToast";
import { useUpdaterStore } from "../stores/updaterStore";
import { RELEASES_URL as RELEASES_URL_FROM_HOOK } from "../hooks/useUpdater";
import { REPO_URL, RELEASES_URL } from "../lib/brand";
import { changeUiLanguage } from "../i18n";

beforeEach(() => {
  shell.open.mockClear();
  useUpdaterStore.getState().reset();
  useUpdaterStore.setState({ autoUpdate: true, skippedVersion: undefined });
});

afterEach(async () => {
  cleanup();
  await changeUiLanguage("en");
});

describe("UpdateReadyToast", () => {
  it("announces a downloaded update and links to this fork's release notes", async () => {
    const user = userEvent.setup();
    useUpdaterStore.setState({ phase: "ready", version: "2.30.0" });
    render(<UpdateReadyToast />);

    expect(await screen.findByText("NexQ Plus v2.30.0 is ready")).toBeInTheDocument();
    expect(screen.getByText("Restart from the footer, or it installs when you quit.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "What's new" }));
    expect(shell.open).toHaveBeenCalledWith(`${RELEASES_URL}/tag/v2.30.0`);
    expect(RELEASES_URL.startsWith(REPO_URL)).toBe(true);
    expect(RELEASES_URL_FROM_HOOK).toBe(RELEASES_URL);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("is translated in Chinese", async () => {
    await changeUiLanguage("zh-CN");
    useUpdaterStore.setState({ phase: "ready", version: "2.30.0", autoUpdate: false });
    render(<UpdateReadyToast />);

    expect(await screen.findByText("NexQ Plus v2.30.0 已就绪")).toBeInTheDocument();
    expect(screen.getByText("在底栏重启即可安装。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更新内容" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });
});
