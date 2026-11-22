import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onQuestionEvent, type DetectedQuestionV2, type QuestionEvent } from "./events";

afterEach(() => clearMocks());

const question: DetectedQuestionV2 = {
  id: "q7",
  revision: 2,
  text: "How would you roll the release back?",
  quote: "how would you roll it back",
  ask_kind: "direct",
  complete: true,
  origin: "model",
  line_id: "them_12",
  timestamp_ms: 84_000,
  source: "Them",
  speaker_done: true,
  prepared: false,
};

describe("onQuestionEvent", () => {
  it("hands over what the backend sends as `question_event`, until it is stopped", async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const seen: QuestionEvent[] = [];
    const stop = await onQuestionEvent((event) => seen.push(event));

    await emit("question_event", { kind: "upsert", question } satisfies QuestionEvent);
    await emit("question_event", { kind: "remove", id: "q7", reason: "superseded" } satisfies QuestionEvent);
    await emit("question_detection_result", { revision: 1 });
    expect(seen).toEqual([
      { kind: "upsert", question },
      { kind: "remove", id: "q7", reason: "superseded" },
    ]);

    // The mock keeps a stopped listener's id and warns that its callback is gone.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await stop();
    await emit("question_event", { kind: "remove", id: "q7", reason: "reset" } satisfies QuestionEvent);
    expect(seen).toHaveLength(2);
    warn.mockRestore();
  });
});
