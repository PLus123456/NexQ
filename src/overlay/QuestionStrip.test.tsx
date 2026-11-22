import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
const question = (text: string, status: FlowQuestion["status"] = "open", patch: Partial<FlowQuestion> = {}): FlowQuestion => {
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
    settings: { mode: "hybrid", confidence_threshold: 0.7, log_requests: false, prediction_enabled: on, prediction_prepare_answers: true },
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
  flow.answer.mockReset();
  flow.dismiss.mockReset();
  flow.mounted.mockReset();
  useQuestionDetectionStore.setState({ view: null });
});

describe("QuestionStrip", () => {
  it("says it is listening while nothing was asked", () => {
    show();
    const region = screen.getByRole("region", { name: "Detected questions" });
    expect(within(region).getByText("Listening for questions from the other party")).toBeInTheDocument();
    expect(within(region).queryByRole("button")).toBeNull();
  });

  it("shows the newest question as a card to click, with an Assist button", () => {
    show(question("What would you do first?"));
    expect(screen.getByText(/What would you do first\?/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Question: What would you do first?. Click to assist" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get AI assistance for this question" })).toHaveTextContent("Assist");
    expect(screen.queryByText("Answered")).toBeNull();
    expect(screen.queryByText("Listening for questions from the other party")).toBeNull();
  });

  it.each(["answered", "answering"] as const)("shows a question whose answer is %s as answered", (status) => {
    show(question("What would you do first?", status));
    expect(screen.getByRole("button", { name: "Question: What would you do first?. Answered" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Already answered" })).toHaveTextContent("Answered");
    expect(screen.queryByRole("button", { name: "Get AI assistance for this question" })).toBeNull();
  });

  it.each(["open", "held"] as const)("shows a question that is %s as one to click, not as answered", (status) => {
    show(question("What would you do first?", status));
    expect(screen.getByRole("button", { name: "Get AI assistance for this question" })).toBeInTheDocument();
    expect(screen.queryByText("Answered")).toBeNull();
  });

  it("a click on the card, on its Assist button, or Enter / Space on it asks for that question's answer", () => {
    show(question("What would you do first?"));
    const card = screen.getByRole("button", { name: /^Question: What would you do first\?/ });

    fireEvent.click(card);
    expect(flow.answer).toHaveBeenCalledExactlyOnceWith("q1");

    // The button sits in the card: one click is one request.
    fireEvent.click(screen.getByRole("button", { name: "Get AI assistance for this question" }));
    expect(flow.answer).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(card, { key: "a" });
    expect(flow.answer).toHaveBeenCalledTimes(4);
    expect(flow.answer).toHaveBeenLastCalledWith("q1");
    expect(flow.dismiss).not.toHaveBeenCalled();
  });

  it("a click on the card of an answered question asks again (the flow decides what that does)", () => {
    show(question("What would you do first?", "answering"));
    fireEvent.click(screen.getByRole("button", { name: /^Question: What would you do first\?/ }));
    expect(flow.answer).toHaveBeenCalledExactlyOnceWith("q1");
  });

  it("the ✕ closes the question without asking for its answer", () => {
    show(question("What would you do first?"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss question" }));
    expect(flow.dismiss).toHaveBeenCalledExactlyOnceWith("q1");
    expect(flow.answer).not.toHaveBeenCalled();
  });

  it("lists the three questions before the newest one, each with its full text as a tooltip", () => {
    show(
      question("Newest?"),
      question("Second?", "held"),
      question("Third?", "answered"),
      question("Fourth?"),
      question("Fifth, not shown?"),
    );
    expect(screen.getByText(/Newest\?/).tagName).toBe("P");
    for (const text of ["Second?", "Third?", "Fourth?"]) {
      expect(screen.getByTitle(text)).toHaveTextContent(text);
    }
    expect(screen.queryByText(/Fifth/)).toBeNull();
    // One ✕ per question shown.
    expect(screen.getAllByRole("button", { name: "Dismiss question" })).toHaveLength(4);
  });

  it("a click on an earlier question asks for its answer, unless it is already answered", () => {
    show(question("Newest?"), question("Second?", "held"), question("Third?", "answered"), question("Fourth?", "answering"));

    fireEvent.click(screen.getByText("Second?"));
    expect(flow.answer).toHaveBeenCalledExactlyOnceWith("q2");

    fireEvent.click(screen.getByText("Third?"));
    fireEvent.click(screen.getByText("Fourth?"));
    expect(flow.answer).toHaveBeenCalledTimes(1);

    // The keyboard asks again for an answered one too.
    fireEvent.keyDown(screen.getByTitle("Third?"), { key: "Enter" });
    expect(flow.answer).toHaveBeenLastCalledWith("q3");
    fireEvent.keyDown(screen.getByTitle("Second?"), { key: " " });
    expect(flow.answer).toHaveBeenLastCalledWith("q2");
    expect(flow.answer).toHaveBeenCalledTimes(3);
  });

  it("the ✕ of an earlier question closes that one only", () => {
    show(question("Newest?"), question("Second?"), question("Third?"));
    const row = screen.getByTitle("Third?");
    fireEvent.click(within(row).getByRole("button", { name: "Dismiss question" }));
    expect(flow.dismiss).toHaveBeenCalledExactlyOnceWith("q3");
    expect(flow.answer).not.toHaveBeenCalled();
  });

  it("follows the flow: an answered question shows as answered, a closed one is gone", () => {
    const first = question("What would you do first?");
    const view = show(first);
    expect(screen.getByRole("button", { name: "Get AI assistance for this question" })).toBeInTheDocument();

    flow.questions = [{ ...first, status: "answered" }];
    view.rerender(<QuestionStrip />);
    expect(screen.getByRole("button", { name: "Already answered" })).toBeInTheDocument();

    flow.questions = [];
    view.rerender(<QuestionStrip />);
    expect(screen.queryByText(/What would you do first\?/)).toBeNull();
    expect(screen.getByText("Listening for questions from the other party")).toBeInTheDocument();
  });
});

describe("QuestionPanel", () => {
  it("shows the strip with Question Detection on, with Auto-Answer off too", () => {
    setDefaults({ questionDetection: true, autoTrigger: false });
    flow.questions = [question("What would you do first?")];
    render(<QuestionPanel />);
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
    expect(screen.getByText(/When can we ship this project\?/)).toBeInTheDocument();
    expect(flow.mounted).toHaveBeenCalled();
  });
});
