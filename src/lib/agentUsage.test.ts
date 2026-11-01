import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changeUiLanguage } from "../i18n";
import {
  API_BILLED_NOTE,
  EMPTY_USAGE,
  NPM_ONLY_NOTE,
  apiBilledNote,
  avgFirstTokenMs,
  avgLatencyMs,
  formatAgo,
  formatCost,
  formatCostEstimate,
  formatDuration,
  formatPromptTokens,
  formatTokenUsage,
  formatTokens,
  formatUsageSummary,
  lastAnswerTooltip,
  npmOnlyNote,
  promptTokens,
} from "./agentUsage";

describe("formatDuration", () => {
  it.each([
    [0, "0 ms"],
    [850, "850 ms"],
    [999, "999 ms"],
    [1000, "1.0 s"],
    [1234, "1.2 s"],
    [9_960, "10.0 s"],
    [30_189, "30 s"],
    [125_000, "2 min 5 s"],
    [120_000, "2 min"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("guards against nonsense", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("formatAgo", () => {
  it("is relative and coarse", () => {
    const now = 1_000_000;
    expect(formatAgo(now - 3_000, now)).toBe("just now");
    expect(formatAgo(now - 40_000, now)).toBe("40 s ago");
    expect(formatAgo(now - 125_000, now)).toBe("2 min ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });
});

const usage = {
  ...EMPTY_USAGE,
  input_tokens: 210,
  cache_read_tokens: 38_000,
  cache_write_tokens: 7_000,
  output_tokens: 1_240,
  thinking_tokens: 300,
  cost_usd: 0.31,
  requests: 3,
  total_latency_ms: 4_200,
  total_first_token_ms: 1_800,
};

describe("usage formatting", () => {
  it("counts cache reads and writes as prompt tokens", () => {
    expect(promptTokens(usage)).toBe(45_210);
    expect(formatTokenUsage(usage)).toBe("in 45,210 (38,000 cached) · out 1,240 (thinking 300)");
    expect(formatTokenUsage({ ...EMPTY_USAGE, input_tokens: 5, output_tokens: 2 })).toBe("in 5 · out 2");
    expect(formatPromptTokens(usage)).toBe("45,210 in (38,000 cached)");
    expect(formatPromptTokens({ ...EMPTY_USAGE, input_tokens: 5 })).toBe("5 in");
  });

  it("groups thousands", () => {
    expect(formatTokens(1_234_567.4)).toBe("1,234,567");
    expect(formatTokens(0)).toBe("0");
  });

  it("summarises requests, tokens and the average response time", () => {
    expect(formatUsageSummary(usage)).toBe("3 requests · 45,210 in (38,000 cached) / 1,240 out · avg 1.4 s");
    expect(formatUsageSummary({ ...EMPTY_USAGE, requests: 1, input_tokens: 9, output_tokens: 1, total_latency_ms: 800 })).toBe(
      "1 request · 9 in / 1 out · avg 800 ms",
    );
    expect(formatUsageSummary(EMPTY_USAGE)).toBe("0 requests · 0 in / 0 out");
  });

  it("averages per answered request", () => {
    expect(avgLatencyMs(usage)).toBe(1_400);
    expect(avgFirstTokenMs(usage)).toBe(600);
    expect(avgLatencyMs(EMPTY_USAGE)).toBeNull();
  });

  it("describes the last answer for the footer tooltip", () => {
    expect(lastAnswerTooltip(1_200, 600)).toBe("Last answer: 1.2 s total, first words after 600 ms");
    expect(lastAnswerTooltip(31_000, null)).toBe("Last answer: 31 s total");
  });

  it("says whether the cost is included in the subscription or billed to the API account", () => {
    expect(formatCostEstimate(usage)).toBe("≈ $0.31 estimate — included in your subscription");
    expect(formatCostEstimate(usage, true)).toBe("≈ $0.31 estimate — billed to your API account");
    expect(formatCost(0.001)).toBe("<$0.01");
    expect(formatCost(0)).toBe("$0.00");
  });
});

describe("the two notes", () => {
  it("come from functions that follow the UI language; the constants stay for old importers", () => {
    expect(apiBilledNote()).toBe(API_BILLED_NOTE);
    expect(npmOnlyNote()).toBe("Found an npm install of Claude Code — NexQ Plus needs the native installer");
    // The constant is the old text, with the old product name.
    expect(NPM_ONLY_NOTE).toContain("NexQ needs the native installer");
  });
});

describe("in Chinese", () => {
  beforeEach(async () => {
    await changeUiLanguage("zh-CN");
  });
  afterEach(async () => {
    await changeUiLanguage("en");
  });

  it("translates durations and relative times", () => {
    const now = 1_000_000;
    expect(formatDuration(850)).toBe("850 毫秒");
    expect(formatDuration(1234)).toBe("1.2 秒");
    expect(formatDuration(30_189)).toBe("30 秒");
    expect(formatDuration(125_000)).toBe("2 分 5 秒");
    expect(formatDuration(120_000)).toBe("2 分钟");
    expect(formatDuration(-1)).toBe("—");
    expect(formatAgo(now - 3_000, now)).toBe("刚刚");
    expect(formatAgo(now - 40_000, now)).toBe("40 秒前");
    expect(formatAgo(now - 125_000, now)).toBe("2 分钟前");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3 小时前");
  });

  it("translates the token, request and cost lines", () => {
    expect(formatTokenUsage(usage)).toBe("输入 45,210（缓存命中 38,000） · 输出 1,240（思考 300）");
    expect(formatTokenUsage({ ...EMPTY_USAGE, input_tokens: 5, output_tokens: 2 })).toBe("输入 5 · 输出 2");
    expect(formatUsageSummary(usage)).toBe("3 次请求 · 输入 45,210（缓存命中 38,000） / 输出 1,240 · 平均 1.4 秒");
    expect(formatCostEstimate(usage)).toBe("估算约 $0.31，已包含在你的订阅中");
    expect(formatCostEstimate(usage, true)).toBe("估算约 $0.31，向你的 API 账户计费");
    expect(lastAnswerTooltip(1_200, 600)).toBe("上次回答：总耗时 1.2 秒，首字延迟 600 毫秒");
    expect(lastAnswerTooltip(31_000, null)).toBe("上次回答：总耗时 31 秒");
  });

  it("translates the notes and names the product", () => {
    expect(apiBilledNote()).toBe("此 Claude 登录向 API 账户计费，而不是使用你的订阅。");
    expect(npmOnlyNote()).toBe("发现通过 npm 安装的 Claude Code，NexQ Plus 需要使用原生安装程序");
  });
});
