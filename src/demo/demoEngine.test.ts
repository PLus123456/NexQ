import { afterEach, expect, it, vi } from "vitest";
import { exitDemo, launchDemo } from "./demoEngine";
import type { DemoScenario } from "./scenarios/types";
import { useStreamStore } from "../stores/streamStore";

afterEach(() => exitDemo());

it("switches demos without losing the user's original state", () => {
  useStreamStore.setState({ currentContent: "user answer" });
  const stopFirst = vi.fn();
  const first: DemoScenario = {
    id: "first", name: "First", description: "", icon: "", supportsPlay: true, window: "overlay",
    populate: () => {},
    play: () => {
      useStreamStore.setState({ currentContent: "first demo" });
      return stopFirst;
    },
  };
  const second: DemoScenario = {
    id: "second", name: "Second", description: "", icon: "", supportsPlay: false, window: "overlay",
    populate: () => useStreamStore.setState({ currentContent: "second demo" }),
  };

  launchDemo(first, "play");
  launchDemo(second, "screenshot");
  expect(stopFirst).toHaveBeenCalledOnce();
  expect(useStreamStore.getState().currentContent).toBe("second demo");
  exitDemo();
  expect(useStreamStore.getState().currentContent).toBe("user answer");
});
