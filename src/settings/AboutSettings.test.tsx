import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({ invoke: vi.fn(async (_cmd: string, _args?: unknown) => null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: core.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({ set: async () => {}, get: async () => undefined, onKeyChange: async () => () => {} }),
}));
const shell = vi.hoisted(() => ({ open: vi.fn(async (_url: string) => {}) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shell.open }));
const os = vi.hoisted(() => ({ arch: vi.fn<() => string>() }));
vi.mock("@tauri-apps/plugin-os", () => ({ arch: () => os.arch() }));

import { AboutSettings } from "./AboutSettings";
import { REPO_URL, UPSTREAM_URL } from "../lib/brand";
import { NEXQ_BUILD_DATE } from "../lib/version";
import { changeUiLanguage } from "../i18n";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const BUILD_DATE_OPTIONS = { year: "numeric", month: "short", day: "numeric" } as const;

/** Latin words in the page's text and labels that aren't in `keep`. */
function untranslatedWords(root: HTMLElement, keep: readonly string[]): string[] {
  const texts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode.textContent ?? "");
  root.querySelectorAll("*").forEach((el) => {
    for (const attr of ["title", "aria-label", "alt", "placeholder"]) {
      const value = el.getAttribute(attr);
      if (value) texts.push(value);
    }
  });
  return texts.flatMap((text) => text.match(/[A-Za-z]{2,}/g) ?? []).filter((w) => !keep.includes(w));
}

beforeEach(() => {
  core.invoke.mockClear();
  shell.open.mockClear();
  // Outside Tauri, plugin-os has no OS info and throws.
  os.arch.mockReset().mockImplementation(() => {
    throw new TypeError("window.__TAURI_OS_PLUGIN_INTERNALS__ is undefined");
  });
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC_UA);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await changeUiLanguage("en");
});

describe("AboutSettings", () => {
  it("says automatic updates are off and offers no update controls", () => {
    render(<AboutSettings />);
    expect(screen.getByText("Automatic updates are off in this build")).toBeInTheDocument();
    expect(
      screen.getByText("NexQ Plus doesn't check for or install updates. Rebuild it from source to update."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Toggle automatic updates" })).not.toBeInTheDocument();
    expect(screen.queryByText("Skip this version")).not.toBeInTheDocument();
    // Nothing asks Rust about updates either (no hydration, no check).
    const commands = core.invoke.mock.calls.map(([cmd]) => cmd);
    expect(commands).not.toContain("check_for_update");
    expect(commands).not.toContain("get_pending_update");
  });

  it("names this build and credits upstream", async () => {
    const user = userEvent.setup();
    render(<AboutSettings />);
    expect(screen.getByRole("heading", { name: "NexQ Plus" })).toBeInTheDocument();
    expect(screen.getByAltText("NexQ Plus")).toBeInTheDocument();

    const upstream = screen.getByRole("link", { name: "NexQ" });
    expect(upstream.closest("p")).toHaveTextContent("Based on NexQ by Vahid Alizadeh (MIT License)");
    await user.click(upstream);
    expect(shell.open).toHaveBeenCalledWith(UPSTREAM_URL);
  });

  it("links to this fork, not to upstream", async () => {
    const user = userEvent.setup();
    render(<AboutSettings />);
    const links: [string, string][] = [
      ["GitHub", REPO_URL],
      ["Changelog", `${REPO_URL}/blob/main/CHANGELOG.md`],
      ["Report Issue", `${REPO_URL}/issues`],
      ["Documentation", `${REPO_URL}#readme`],
    ];
    for (const [name, url] of links) {
      await user.click(screen.getByRole("button", { name }));
      expect(shell.open).toHaveBeenLastCalledWith(url);
    }
    expect(REPO_URL).not.toBe(UPSTREAM_URL);
    expect(shell.open.mock.calls.map(([url]) => url).filter((url) => url.includes("naxhq"))).toEqual([]);
  });

  it("shows the platform and architecture it runs on", () => {
    os.arch.mockReturnValue("aarch64");
    render(<AboutSettings />);
    expect(screen.getByText("macOS")).toBeInTheDocument();
    expect(screen.getByText("aarch64")).toBeInTheDocument();
    expect(screen.queryByText("Windows x64")).not.toBeInTheDocument();
    expect(screen.queryByText("x86_64")).not.toBeInTheDocument();
  });

  it("falls back to a dash when the architecture is unknown", () => {
    render(<AboutSettings />);
    expect(screen.getByText("Architecture").nextElementSibling).toHaveTextContent("—");
  });

  it("formats the build date as before", () => {
    render(<AboutSettings />);
    const before = new Date(NEXQ_BUILD_DATE).toLocaleDateString("en-US", BUILD_DATE_OPTIONS);
    expect(screen.getByText("Build Date").nextElementSibling).toHaveTextContent(before);
  });

  it("warns against running the official NexQ at the same time", () => {
    render(<AboutSettings />);
    expect(screen.getByText("Don't run both versions at once")).toBeInTheDocument();
    expect(screen.getByText(/the one launched second can't register the global shortcuts/)).toBeInTheDocument();
  });

  it("is fully translated in Chinese", async () => {
    await changeUiLanguage("zh-CN");
    const { container } = render(<AboutSettings />);

    expect(screen.getByText("自用版已关闭自动更新")).toBeInTheDocument();
    expect(screen.getByText("NexQ Plus 不会检查或安装更新，需要更新时请从源码重新构建。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "naxhq/NexQ" }).closest("p")).toHaveTextContent(
      "基于 naxhq/NexQ（MIT 许可证）开发，原版权 © 2026 Vahid Alizadeh",
    );
    expect(screen.getByText("不要同时运行两个版本")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "切换详细日志" })).toBeInTheDocument();
    const zhDate = new Date(NEXQ_BUILD_DATE).toLocaleDateString("zh-CN", BUILD_DATE_OPTIONS);
    expect(screen.getByText("构建日期").nextElementSibling).toHaveTextContent(zhDate);

    // Only names stay in Latin script: the product, upstream, its author, the stack, brands.
    const keep = ["NexQ", "Plus", "naxhq", "Vahid", "Alizadeh", "MIT", "Tauri", "React", "Rust", "macOS",
      "GitHub", "Ollama", "LM", "Studio", "AI", "API", "Key"];
    expect(untranslatedWords(container, keep)).toEqual([]);
  });
});
