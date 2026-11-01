// The About page of a build with the updater on (UPDATER_ENABLED, brand.ts):
// the update controls are still there, and translated.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/brand", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/brand")>()),
  UPDATER_ENABLED: true,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(async () => {}) }));

import { AboutSettings } from "./AboutSettings";
import { useUpdaterStore } from "../stores/updaterStore";
import { changeUiLanguage } from "../i18n";

beforeEach(() => {
  useUpdaterStore.getState().reset();
  useUpdaterStore.setState({ autoUpdate: true, skippedVersion: undefined });
});

afterEach(async () => {
  cleanup();
  await changeUiLanguage("en");
});

describe("AboutSettings with the updater on", () => {
  it("shows the update status and controls", () => {
    useUpdaterStore.setState({ lastChecked: Date.now() - 5 * 60_000 });
    render(<AboutSettings />);
    expect(screen.getByText("You're up to date")).toBeInTheDocument();
    expect(screen.getByText("Last checked 5 min ago")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Toggle automatic updates" })).toBeInTheDocument();
    expect(screen.queryByText("Automatic updates are off in this build")).not.toBeInTheDocument();
  });

  it("is translated in Chinese", async () => {
    await changeUiLanguage("zh-CN");
    useUpdaterStore.setState({ version: "2.30.0", autoUpdate: false, lastChecked: Date.now() - 2 * 3_600_000 });
    render(<AboutSettings />);
    expect(screen.getByText("发现新版本 v2.30.0")).toBeInTheDocument();
    expect(screen.getByText("自动更新已关闭")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳过这个版本" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "切换自动更新" })).toBeInTheDocument();
  });

  it("pluralizes how long ago it checked", async () => {
    useUpdaterStore.setState({ lastChecked: Date.now() - 3_600_000 });
    const view = render(<AboutSettings />);
    expect(screen.getByText("Last checked 1h ago")).toBeInTheDocument();
    view.unmount();

    await changeUiLanguage("zh-CN");
    useUpdaterStore.setState({ lastChecked: Date.now() - 10_000 });
    render(<AboutSettings />);
    expect(screen.getByText("上次检查：刚刚")).toBeInTheDocument();
  });
});
