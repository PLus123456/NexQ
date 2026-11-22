import { describe, expect, it } from "vitest";
import {
  extraBodyThinkingKey,
  formatTokenCount,
  layeredThinking,
  mergedExtraBody,
  normalizeConnection,
  normalizeView,
  parseTokenCount,
  thinkingOf,
} from "./connection";

describe("context lengths", () => {
  it("reads the sizes people type", () => {
    expect(parseTokenCount("1M")).toBe(1_000_000);
    expect(parseTokenCount(" 256k ")).toBe(256_000);
    expect(parseTokenCount("1.5m")).toBe(1_500_000);
    expect(parseTokenCount("100万")).toBe(1_000_000);
    expect(parseTokenCount("1,024,000")).toBe(1_024_000);
    expect(parseTokenCount("")).toBeNull();
    expect(parseTokenCount("0")).toBeUndefined();
    expect(parseTokenCount("1x")).toBeUndefined();
    expect(parseTokenCount("-5")).toBeUndefined();
  });

  it("writes them back so they read the same", () => {
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_024_000)).toBe("1024K");
    expect(formatTokenCount(262_144)).toBe("262144");
    for (const tokens of [1_000_000, 1_024_000, 262_144, 32_768]) {
      expect(parseTokenCount(formatTokenCount(tokens))).toBe(tokens);
    }
  });
});

describe("thinking", () => {
  it("keeps Off, Low and High; Auto and anything unknown count as not set", () => {
    expect(normalizeConnection({ id: "c_1", params: { temperature: 0.2, thinking: "off" } }).params).toEqual({
      temperature: 0.2,
      thinking: "off",
    });
    for (const value of ["auto", "max", "", null, 3]) {
      expect(normalizeConnection({ id: "c_1", params: { thinking: value } }).params).toEqual({});
    }
  });

  it("reads a task route's setting the same way", () => {
    const view = normalizeView({
      routing: {
        default: { target: null, params: { thinking: "high" } },
        tasks: { translation: { target: null, params: { thinking: "auto", max_tokens: 200 } } },
      },
    });
    expect(view.routing.default.params).toEqual({ thinking: "high" });
    expect(view.routing.tasks.translation.params).toEqual({ max_tokens: 200 });
    expect(thinkingOf(view.routing.default.params)).toBe("high");
    expect(thinkingOf(view.routing.tasks.translation.params)).toBe("auto");
    expect(thinkingOf(null)).toBe("auto");
  });

  it("layers add up to the last setting that isn't Auto", () => {
    expect(layeredThinking([])).toBe("auto");
    expect(layeredThinking([{ thinking: "high" }, { thinking: "off" }])).toBe("off");
    expect(layeredThinking([{ thinking: "high" }, {}, { thinking: "auto" }])).toBe("high");
    expect(layeredThinking([{}, null, undefined])).toBe("auto");
  });
});

describe("a thinking key in the extra request body", () => {
  it("merges the layers' bodies like the backend: objects merge, null deletes, the rest replaces", () => {
    expect(
      mergedExtraBody([
        { extra_body: { seed: 7, options: { num_ctx: 8192, top_k: 40 }, reasoning_effort: "low" } },
        {},
        { extra_body: { options: { top_k: null, num_predict: 256 }, reasoning_effort: null } },
      ]),
    ).toEqual({ seed: 7, options: { num_ctx: 8192, num_predict: 256 } });
    expect(mergedExtraBody([])).toEqual({});
    // A null in the lowest layer adds nothing.
    expect(mergedExtraBody([{ extra_body: { think: null } }])).toEqual({});
  });

  // The same cases as `extra_body_sets_thinking_only_with_a_thinking_key` in src-tauri/src/llm/compat.rs.
  it.each([
    [{ thinking: { type: "disabled" } }, "thinking"],
    [{ think: false }, "think"],
    [{ reasoning: { enabled: false } }, "reasoning"],
    [{ reasoning_effort: "none" }, "reasoning_effort"],
    [{ enable_thinking: false }, "enable_thinking"],
    [{ thinking_budget: 1024 }, "thinking_budget"],
    [{ chat_template_kwargs: { enable_thinking: false } }, "chat_template_kwargs.enable_thinking"],
    [{ generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }, "generationConfig.thinkingConfig"],
    [{ generation_config: { thinking_config: {} } }, "generation_config.thinking_config"],
  ])("%j sets thinking by hand", (extra, key) => {
    expect(extraBodyThinkingKey(extra)).toBe(key);
  });

  it.each([
    [{}],
    [{ seed: 7, top_p: 0.9 }],
    [{ chat_template_kwargs: { add_generation_prompt: true } }],
    [{ generationConfig: { maxOutputTokens: 10 } }],
    [null],
  ])("%j doesn't", (extra) => {
    expect(extraBodyThinkingKey(extra)).toBeNull();
  });

  it("counts a key of any layer unless a later layer removes it", () => {
    const connection = { extra_body: { reasoning_effort: "low" } };
    expect(extraBodyThinkingKey(mergedExtraBody([connection, { temperature: 0.2 }]))).toBe("reasoning_effort");
    expect(extraBodyThinkingKey(mergedExtraBody([connection, { extra_body: { reasoning_effort: null } }]))).toBeNull();
  });
});
