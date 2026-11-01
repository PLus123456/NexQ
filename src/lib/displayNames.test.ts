import { afterEach, describe, expect, it } from "vitest";
import { changeUiLanguage } from "../i18n";
import { actionDisplayName } from "./actionNames";
import {
  BUILT_IN_SCENARIOS,
  NOISE_PRESETS,
  noisePresetDescription,
  noisePresetName,
  scenarioDescription,
  scenarioName,
} from "./scenarios";

const BUILT_IN_ACTIONS = [
  { id: "Assist", name: "Assist" },
  { id: "WhatToSay", name: "Say" },
  { id: "Shorten", name: "Short" },
  { id: "FollowUp", name: "F/U" },
  { id: "Recap", name: "Recap" },
  { id: "AskQuestion", name: "Ask" },
];

describe("display names of built-in items", () => {
  afterEach(async () => {
    await changeUiLanguage("en");
  });

  it("keep the original English text", () => {
    for (const action of BUILT_IN_ACTIONS) {
      expect(actionDisplayName({ ...action, isBuiltIn: true })).toBe(action.name);
    }
    for (const s of BUILT_IN_SCENARIOS) {
      expect(scenarioName(s)).toBe(s.name);
      expect(scenarioDescription(s)).toBe(s.description);
    }
    for (const p of NOISE_PRESETS) {
      expect(noisePresetName(p)).toBe(p.name);
      expect(noisePresetDescription(p)).toBe(p.description);
    }
  });

  it("are translated into Chinese", async () => {
    await changeUiLanguage("zh-CN");
    const zhName = (action: { id: string; name: string }) => actionDisplayName({ ...action, isBuiltIn: true });
    expect(BUILT_IN_ACTIONS.map(zhName)).toEqual(["助手", "怎么说", "精简", "追问", "回顾", "提问"]);
    for (const s of BUILT_IN_SCENARIOS) {
      expect(scenarioName(s)).toMatch(/[一-鿿]/);
      expect(scenarioDescription(s)).toMatch(/[一-鿿]/);
    }
    for (const p of NOISE_PRESETS) {
      expect(noisePresetName(p)).toMatch(/[一-鿿]/);
      expect(noisePresetDescription(p)).toMatch(/[一-鿿]/);
    }
  });

  it("leave what the user typed alone", async () => {
    await changeUiLanguage("zh-CN");
    expect(actionDisplayName({ id: "custom_1", name: "Say hi", isBuiltIn: false })).toBe("Say hi");
    // A built-in id the app doesn't know keeps its stored name.
    expect(actionDisplayName({ id: "Future", name: "Future", isBuiltIn: true })).toBe("Future");
    const custom = { id: "mine", name: "Team Meeting", description: "Mine", is_custom: true };
    expect(scenarioName(custom)).toBe("Team Meeting");
    expect(scenarioDescription(custom)).toBe("Mine");
  });
});
