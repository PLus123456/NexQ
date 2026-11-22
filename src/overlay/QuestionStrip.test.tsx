import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowQuestion, QuestionFlow } from "./questionFlow";

// The strip renders what the flow gives it and reports clicks back; which
// questions exist and what a click leads to is covered in questionFlow.test.tsx.
const flow = vi.hoisted(() => ({
  questions: [] as FlowQuestion[],
  answer: vi.fn<(id: string) => void>(),
  dismiss: vi.fn<(id: string) => void>(),
  /** Called each time the hook runs: the flow is mounted. */
  mounted: vi.fn(),
}));
vi.mock("./questionFlow", () => ({
  useQuestionFlow: (): QuestionFlow => {
    flow.mounted();
    return { questions: flow.questions, answer: flow.answer, dismiss: flow.dismiss };
  },
}));

import { QuestionPanel, QuestionStrip } from "./QuestionStrip";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { useQuestionDetectionStore } from "../stores/questionDetectionStore";
import type { QuestionDetectionSettingsView } from "../lib/questionDetection/types";
import type { GlobalDefaults } from "../lib/types";

let nextId = 0;
const question = (
  text: string,
  status: FlowQuestion["status"] = "open",
  patch: Partial<FlowQuestion> = {},
): FlowQuestion => {
  nextId += 1;
  return { id: `q${nextId}`, text, askKind: "direct", status, prepared: false, timestampMs: nextId * 1000, ...patch };
};

function show(...questions: FlowQuestion[]) {
  flow.questions = questions;
  return render(<QuestionStrip />);
}

function setDefaults(defaults: Partial<GlobalDefaults>) {
  const { configs } = useAIActionsStore.getState();
  useAIActionsStore.setState({ configs: { ...configs, globalDefaults: { ...configs.globalDefaults, ...defaults } } });
}

function setPredictions(on: boolean) {
  const view: QuestionDetectionSettingsView = {
    revision: 1,
    settings: {
      mode: "hybrid",
      confidence_threshold: 0.7,
      log_requests: false,
      prediction_enabled: on,
      prediction_prepare_answers: true,
    },
    effective_mode: "hybrid",
    fallback_reason: null,
  };
  useQuestionDetectionStore.setState({ view });
}

beforeEach(() => {
  nextId = 0;
  flow.questions = [];
  setDefaults({ questionDetection: true, autoTrigger: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  flow.answer.mockReset();
  flow.dismiss.mockReset();
  flow.mounted.mockReset();
  useQuestionDetectionStore.setState({ view: null });
});

describe("QuestionStrip", () => {
  it("shows a faint single-line placeholder while nothing was asked", () => {
    show();
    const region = screen.getByRole("region", { name: "Detected questions" });
    expect(within(region).getByText("Listening for questions from the other party")).toBeInTheDocument();
    expect(within(region).queryByRole("button")).toBeNull();
  });

  it("shows the newest question clamped to two lines with an Assist button and no nav when alone", () => {
    show(question("What would you do first?"));
    const p = screen.getByText("What would you do first?");
    expect(p.tagName).toBe("P");
    expect(p.className).toContain("line-clamp-2");
    expect(screen.getByRole("button", { name: "Get AI assistance for this question" })).toHaveTextContent("Assist");
    expect(screen.queryByRole("button", { name: "Older question" })).toBeNull();
    expect(screen.queryByText("Listening for questions from the other party")).toBeNull();
  });

  it.each([
    ["detecting", "Detecting", "Get AI assistance for this question", "Assist"],
    ["open", "Ready", "Get AI assistance for this question", "Assist"],
    ["answering", "Answering", null, null],
    ["answered", "Answered", "Answer this question again", "Re-answer"],
    ["held", "Click to answer", "Get AI assistance for this question", "Assist"],
  ] as const)("renders status badge and action button for status '%s'", (status, badge, actionAria, actionText) => {
    show(question("How did you scale it?", status));
    const region = screen.getByRole("region", { name: "Detected questions" });
    expect(region.querySelector(`[data-question-status="${status}"]`)).toHaveTextContent(badge);
    if (actionAria && actionText) {
      expect(screen.getByRole("button", { name: actionAria })).toHaveTextContent(actionText);
    } else {
      expect(screen.queryByRole("button", { name: "Get AI assistance for this question" })).toBeNull();
    }
  });

  it("clicking the Assist / Re-answer button requests an answer for the displayed question", () => {
    show(question("What would you do first?", "open"));
    fireEvent.click(screen.getByRole("button", { name: "Get AI assistance for this question" }));
    expect(flow.answer).toHaveBeenCalledExactlyOnceWith("q1");
    expect(flow.dismiss).not.toHaveBeenCalled();
  });

  it("clicking Re-answer on an answered question asks again", () => {
    show(question("What would you do first?", "answered"));
    fireEvent.click(screen.getByRole("button", { name: "Answer this question again" }));
    expect(flow.answer).toHaveBeenCalledExactlyOnceWith("q1");
  });

  it("clicking Dismiss closes the question without asking for its answer", () => {
    show(question("What would you do first?"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss question" }));
    expect(flow.dismiss).toHaveBeenCalledExactlyOnceWith("q1");
    expect(flow.answer).not.toHaveBeenCalled();
  });

  it("navigates between questions with prev / next and acts on the selected one", () => {
    show(
      question("Newest?", "open"),
      question("Second?", "held"),
      question("Third?", "answered"),
    );
    const prev = screen.getByRole("button", { name: "Newer question" });
    const next = screen.getByRole("button", { name: "Older question" });

    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(prev).toBeDisabled();
    expect(next).not.toBeDisabled();
    expect(screen.getByText("Newest?")).toBeInTheDocument();

    fireEvent.click(next);
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText("Second?")).toBeInTheDocument();
    expect(prev).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Get AI assistance for this question" }));
    expect(flow.answer).toHaveBeenCalledExactlyOnceWith("q2");

    fireEvent.click(next);
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    expect(screen.getByText("Third?")).toBeInTheDocument();
    expect(next).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss question" }));
    expect(flow.dismiss).toHaveBeenCalledExactlyOnceWith("q3");

    fireEvent.click(prev);
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });

  it("jumps back to the newest question when a brand-new question arrives", () => {
    const q1 = question("First?");
    const q2 = question("Older?");
    const view = show(q1, q2);
    fireEvent.click(screen.getByRole("button", { name: "Older question" }));
    expect(screen.getByText("Older?")).toBeInTheDocument();

    const q3 = question("Brand new?");
    flow.questions = [q3, q1, q2];
    view.rerender(<QuestionStrip />);
    expect(screen.getByText("Brand new?")).toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
  });

  it("opens the full question in a portal popover on click and closes on Escape", () => {
    const longText = "A very long multi-line interview question about distributed consensus and rate limiting?";
    show(question(longText, "open", { prepared: true }));

    const trigger = screen.getByRole("button", { name: `Question: ${longText}. Click to assist` });
    expect(screen.queryByRole("dialog", { name: "Full question" })).toBeNull();

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Full question" });
    expect(dialog).toBeInTheDocument();
    // Rendered as a portal on document.body, outside the strip region (so it cannot push the answer down).
    expect(screen.getByRole("region", { name: "Detected questions" }).contains(dialog)).toBe(false);
    expect(within(dialog).getByText(longText)).toBeInTheDocument();
    expect(within(dialog).getByText("Prepared in advance")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Full question" })).toBeNull();
  });

  it("opens the full question popover on hover and closes shortly after mouse leaves", () => {
    vi.useFakeTimers();
    const longText = "Walk me through the database sharding strategy you used in production.";
    show(question(longText, "held"));

    const trigger = screen.getByRole("button", { name: `Question: ${longText}. Click to assist` });
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("dialog", { name: "Full question" })).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole("dialog", { name: "Full question" })).toBeNull();
  });

  it("popover action button answers the question and closes the popover", () => {
    show(question("Why did you pick Kafka?"));
    fireEvent.click(screen.getByRole("button", { name: /Question: Why did you pick Kafka/ }));
    const dialog = screen.getByRole("dialog", { name: "Full question" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Assist" }));
    expect(flow.answer).toHaveBeenCalledExactlyOnceWith("q1");
    expect(screen.queryByRole("dialog", { name: "Full question" })).toBeNull();
  });

  it("follows the flow: an answered question updates its status and a closed one disappears", () => {
    const first = question("What would you do first?");
    const view = show(first);
    expect(screen.getByRole("button", { name: "Get AI assistance for this question" })).toBeInTheDocument();

    flow.questions = [{ ...first, status: "answered" }];
    view.rerender(<QuestionStrip />);
    expect(screen.getByRole("button", { name: "Answer this question again" })).toBeInTheDocument();

    flow.questions = [];
    view.rerender(<QuestionStrip />);
    expect(screen.queryByText(/What would you do first\?/)).toBeNull();
    expect(screen.getByText("Listening for questions from the other party")).toBeInTheDocument();
  });
});

describe("QuestionPanel", () => {
  it("caps its height at 72px and shows the strip with Question Detection on (even with Auto-Answer off)", () => {
    setDefaults({ questionDetection: true, autoTrigger: false });
    flow.questions = [question("What would you do first?")];
    render(<QuestionPanel />);
    const panel = screen.getByTestId("question-panel");
    expect(panel.className).toContain("max-h-[72px]");
    expect(screen.getByRole("region", { name: "Detected questions" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Get AI assistance for this question" }));
    expect(flow.answer).toHaveBeenCalledExactlyOnceWith("q1");
  });

  it("shows nothing and runs no flow with detection off, so nothing is listed or answered", () => {
    setDefaults({ questionDetection: false, autoTrigger: true });
    flow.questions = [question("What would you do first?")];
    const { container } = render(<QuestionPanel />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/What would you do first\?/)).toBeNull();
    expect(flow.mounted).not.toHaveBeenCalled();
  });

  it("still shows with detection off while predicted questions are on (their prepared answers replay)", () => {
    setDefaults({ questionDetection: false, autoTrigger: false });
    setPredictions(true);
    flow.questions = [question("When can we ship this project?", "answered", { prepared: true })];
    render(<QuestionPanel />);
    expect(screen.getByRole("region", { name: "Detected questions" })).toBeInTheDocument();
    expect(screen.getByText("When can we ship this project?")).toBeInTheDocument();
    expect(flow.mounted).toHaveBeenCalled();
  });
});
