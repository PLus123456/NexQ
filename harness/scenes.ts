// Scenes of the preview harness: they put SYNTHETIC data into the app's real
// stores (an invented interview; never a real transcript) and play scripted
// backend events. main.tsx loads this file after the Tauri mocks are in place.

import { emitEvent, onCommand } from "./mocks";
import MARKDOWN_ANSWER from "./fixtures/answer.md?raw";
import MORE_TO_SAY from "./fixtures/answer-more.md?raw";
import type { TranslationChunk } from "../src/lib/captions/types";
import type { IntelligenceMode, Meeting, TranscriptSegment, TranslationResult } from "../src/lib/types";
import { useAIActionsStore } from "../src/stores/aiActionsStore";
import { useConfigStore } from "../src/stores/configStore";
import { useMeetingStore } from "../src/stores/meetingStore";
import { useQuestionStore } from "../src/stores/questionStore";
import { initMeetingSpeakers } from "../src/stores/resetMeeting";
import { useScenarioStore } from "../src/stores/scenarioStore";
import { useStreamStore } from "../src/stores/streamStore";
import { useTranscriptStore } from "../src/stores/transcriptStore";
import { useTranslationStore } from "../src/stores/translationStore";

export const SCENES = ["idle", "question", "streaming", "answered", "markdown", "transcript"] as const;
export type SceneName = (typeof SCENES)[number];

type Party = "them" | "you";

/** How long the invented meeting has been running. */
const ELAPSED_MS = 14 * 60_000 + 32_000;

// ── transcript ──────────────────────────────────────────────────────────────

/** [who, what they said, its Chinese translation] */
const CONVERSATION: Array<[Party, string, string]> = [
  ["them", "Thanks for joining. Let's start with the project on your résumé, the billing migration.", "感谢你来参加。我们先聊聊你简历上的那个项目，计费系统迁移。"],
  ["you", "Sure. We moved billing from a monolith to event-driven services over about nine months.", "好的。我们用了大约九个月，把计费从单体迁移到了事件驱动的服务。"],
  ["them", "What was the hardest part of that?", "其中最难的部分是什么？"],
  ["you", "Keeping both systems consistent while traffic was still flowing through the old one.", "在流量还走旧系统的时候，保持两套系统的数据一致。"],
  ["them", "Mm-hmm. And how did you verify that nothing was lost?", "嗯。那你们怎么确认没有丢数据？"],
  ["you", "We ran a shadow ledger and compared totals every hour, then every five minutes near the cut-over.", "我们跑了一份影子账本，每小时对一次总额，临近切换时改成每五分钟一次。"],
  ["them", "Okay. Let's talk about scale for a moment.", "好。我们聊一下规模。"],
  ["them", "How many requests per second did the new service handle at peak?", "新服务在高峰期每秒处理多少请求？"],
  ["you", "Around four thousand at peak, with a p99 latency under eighty milliseconds.", "高峰期大约四千，p99 延迟低于八十毫秒。"],
  ["them", "And if one region goes down, what happens to in-flight payments?", "如果一个区域宕机，正在处理的支付会怎样？"],
  ["you", "They are retried from the outbox once the other region takes over, and every write is idempotent.", "另一个区域接管后会从发件箱重试，而且每次写入都是幂等的。"],
  ["them", "Good. I'd like to go a bit deeper on rate limiting next.", "不错。接下来我想深入聊一下限流。"],
];

/** A line of the invented meeting, `secondsAgo` before now. */
function line(index: number, party: Party, text: string, secondsAgo: number): TranscriptSegment {
  return {
    id: `${party}_${index + 1}`,
    text,
    speaker: party === "you" ? "User" : "Them",
    speaker_id: party,
    timestamp_ms: Date.now() - secondsAgo * 1000,
    is_final: true,
    confidence: 0.94,
  };
}

function translationOf(segment: TranscriptSegment, translated: string): TranslationResult {
  return {
    segment_id: segment.id,
    original_text: segment.text,
    translated_text: translated,
    source_lang: "en",
    target_lang: "zh",
    provider: "soniox",
    is_final: true,
  };
}

/**
 * Puts `lines` into the transcript, the newest a few seconds ago, each with
 * its translation. Returns the transcript lines.
 */
function seedTranscript(lines: Array<[Party, string, string]>): TranscriptSegment[] {
  const segments = lines.map(([party, text], i) => line(i, party, text, (lines.length - i) * 9));
  useTranscriptStore.setState({ segments });
  useTranslationStore.getState().addTranslations(segments.map((segment, i) => translationOf(segment, lines[i][2])));
  return segments;
}

// ── questions ───────────────────────────────────────────────────────────────

/** The question they ask last. It needs three lines in a 420 px wide window. */
const LONG_QUESTION: [Party, string, string] = [
  "them",
  "You mentioned keeping the monolith and the new event-driven services consistent during the cut-over: "
    + "can you walk me through how you would design the rate limiter in front of them, "
    + "and what you would do differently if you had to build it again today?",
  "你提到切换期间要让单体和新的事件驱动服务保持一致：能不能讲讲你会怎么设计它们前面的限流器，如果今天重做一遍，你会有哪些不同的做法？",
];

/** The questions detected in CONVERSATION: [line, the question, what became of it]. */
const DETECTED: Array<[line: number, text: string, state: "open" | "answered" | "held"]> = [
  [2, "What was the hardest part of that?", "answered"],
  [4, "How did you verify that nothing was lost?", "held"],
  [7, "How many requests per second did the new service handle at peak?", "answered"],
  [9, "And if one region goes down, what happens to in-flight payments?", "open"],
];

/**
 * The detected questions of the transcript, in the states a meeting leaves
 * them in, and the long one as the newest, not answered yet.
 */
function seedQuestions(transcript: TranscriptSegment[]) {
  const store = useQuestionStore.getState();
  const detect = (segment: TranscriptSegment, text: string) =>
    store.addQuestion({ text, confidence: 0.9, timestamp_ms: segment.timestamp_ms, source: "Them" }, segment.id);
  for (const [index, text, state] of DETECTED) {
    const segment = transcript[index];
    detect(segment, text);
    if (state === "answered") store.markAssisted(0);
    if (state === "held") store.holdBack(segment.id, text);
  }
  const last = transcript[transcript.length - 1];
  detect(last, last.text);
  return last;
}

// ── answers ─────────────────────────────────────────────────────────────────

// fixtures/answer.md is a finished answer with everything the answer renderer
// has to handle: headings, nested lists, a table, inline code, a code block,
// inline math `\( … \)` and display math `\[ … \]`, a quote, a link, an amount
// in dollars, Chinese next to English. fixtures/answer-more.md follows it in
// the streaming scene, so the answer outgrows any window.

const SHORT_ANSWERS: Array<{ mode: IntelligenceMode; text: string }> = [
  { mode: "Recap", text: "So far: the billing migration, how consistency was checked (shadow ledger, hourly then five-minute comparisons), and peak load of about 4,000 requests per second." },
  { mode: "FollowUp", text: "Ask which part of their own platform still runs on the old stack, and who owns the cut-over plan." },
];

const MODEL = "synthetic-model";
const PROVIDER = "harness";
/** Characters per tick and tick length of a simulated answer: about 200 characters a second. */
const STREAM_STEP = 6;
const STREAM_TICK_MS = 30;

/** Puts a finished answer into the answer panel and its history. */
function showAnswer(mode: IntelligenceMode, text: string) {
  useStreamStore.getState().startStream(mode, MODEL, PROVIDER, { requestId: crypto.randomUUID() });
  useStreamStore.getState().appendToken(text);
  useStreamStore.getState().endStream(1840);
}

const running = new Map<string, () => void>();

/**
 * Streams `text` into the answer panel like a provider would, a few
 * characters at a time. Resolves when the answer has ended or was stopped
 * (`stopAnswer`), as the backend's `generate_assist` does.
 */
function streamAnswer(mode: IntelligenceMode, requestId: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    useStreamStore.getState().startStream(mode, MODEL, PROVIDER, { requestId });
    const startedAt = Date.now();
    let sent = 0;
    const end = () => {
      clearInterval(timer);
      running.delete(requestId);
      const now = useStreamStore.getState();
      if (now.isStreaming && now.streamRequestId === requestId) now.endStream(Date.now() - startedAt);
      resolve();
    };
    const timer = setInterval(() => {
      const now = useStreamStore.getState();
      // Another answer took the panel over.
      if (!now.isStreaming || now.streamRequestId !== requestId) return end();
      now.appendToken(text.slice(sent, sent + STREAM_STEP));
      sent += STREAM_STEP;
      if (sent >= text.length) end();
    }, STREAM_TICK_MS);
    running.set(requestId, end);
  });
}

function stopAnswer(requestId?: string) {
  for (const [id, end] of [...running]) if (!requestId || id === requestId) end();
}

/**
 * Buttons that ask for an answer (a mode, Ask, a question card) get a
 * synthetic one, streamed like a real one; Stop stops it.
 */
function installAnswerSimulator() {
  onCommand("generate_assist", async (args) => {
    // The backend's own words when an answer is already running.
    if (running.size > 0) throw "Generation already in progress";
    // A custom action's id passes as a mode, as it does in the app's stream events.
    const mode = String(args.mode ?? "Assist") as IntelligenceMode;
    const requestId = String(args.requestId ?? crypto.randomUUID());
    const asked = typeof args.customQuestion === "string" ? `> ${args.customQuestion}\n\n` : "";
    await streamAnswer(mode, requestId, `${asked}${MARKDOWN_ANSWER}`);
    return null;
  });
  onCommand("cancel_generation", (args) => {
    stopAnswer(typeof args.requestId === "string" ? args.requestId : undefined);
    return null;
  });
}

/** The question of `asked` is being answered: the answer keeps growing, and starts over when it is done. */
function streamForever(asked: TranscriptSegment) {
  const once = () => {
    const requestId = crypto.randomUUID();
    const done = streamAnswer("Assist", requestId, MARKDOWN_ANSWER + MORE_TO_SAY);
    // As Auto-Answer records an answer it started: the question shows as being answered.
    const store = useQuestionStore.getState();
    store.answerLine({ text: asked.text, confidence: 0.9, timestamp_ms: asked.timestamp_ms, source: "Them" }, asked.id);
    store.setAutoAnswer({ requestId, segmentId: asked.id, question: asked.text, early: false, done });
    void done.then(() => setTimeout(() => { if (running.size === 0) once(); }, 2500));
  };
  once();
}

// ── overlay scenes ──────────────────────────────────────────────────────────

/** An invented meeting in progress, as the overlay window has it after `nexq:meeting_started`. */
function startMeeting(title: string) {
  const startedAt = Date.now() - ELAPSED_MS;
  const meeting: Meeting = {
    id: "harness-meeting",
    title,
    start_time: new Date(startedAt).toISOString(),
    end_time: null,
    duration_seconds: null,
    transcript: [],
    ai_interactions: [],
    summary: null,
    config_snapshot: null,
    audio_mode: "online",
    ai_scenario: "interview",
  };
  initMeetingSpeakers("online");
  useScenarioStore.setState({ activeScenarioId: "interview" });
  useConfigStore.setState({ recordingEnabled: true });
  useTranslationStore.setState({ autoTranslateActive: true, displayMode: "inline", targetLang: "zh" });
  useMeetingStore.setState({
    activeMeeting: meeting,
    currentView: "overlay",
    audioMode: "online",
    aiScenario: "interview",
    isRecording: true,
    meetingStartTime: startedAt,
    elapsedMs: ELAPSED_MS,
  });
  // Detected questions stay as seeded: nothing answers them by itself.
  const { configs } = useAIActionsStore.getState();
  useAIActionsStore.setState({
    configs: { ...configs, globalDefaults: { ...configs.globalDefaults, questionDetection: true, autoTrigger: false } },
  });
}

/** Seeds the stores for an overlay scene. Call once, before the overlay renders. */
export function seedOverlayScene(scene: SceneName, meetingTitle: string) {
  installAnswerSimulator();
  startMeeting(meetingTitle);

  if (scene === "idle") {
    seedTranscript(CONVERSATION.slice(0, 2));
    return;
  }
  if (scene === "transcript") {
    // Many lines: the conversation, four times over.
    seedTranscript(Array.from({ length: 48 }, (_, i) => CONVERSATION[i % CONVERSATION.length]));
    return;
  }
  if (scene === "markdown") {
    seedTranscript(CONVERSATION);
    showAnswer("Assist", MARKDOWN_ANSWER);
    return;
  }

  const asked = seedQuestions(seedTranscript([...CONVERSATION, LONG_QUESTION]));
  if (scene === "streaming") {
    streamForever(asked);
  } else if (scene === "answered") {
    // Earlier answers in the history, the newest question answered with the long one.
    for (const { mode, text } of SHORT_ANSWERS) showAnswer(mode, text);
    showAnswer("Assist", MARKDOWN_ANSWER);
    useQuestionStore.getState().markAssisted(0);
  }
}

// ── caption script ──────────────────────────────────────────────────────────

/** A line of the caption script: its clauses in order, each with its translation. */
interface ScriptLine {
  party: Party;
  clauses: Array<[source: string, translation: string]>;
}

const CAPTION_SCRIPT: ScriptLine[] = [
  {
    party: "them",
    clauses: [
      ["Thanks for making the time today.", "感谢你今天抽出时间。"],
      ["I run the platform team here,", "我负责这里的平台团队，"],
      ["and I'd like to hear about the billing migration you led.", "想听听你主导的那次计费迁移。"],
    ],
  },
  {
    party: "you",
    clauses: [
      ["Happy to.", "没问题。"],
      ["We moved billing off a monolith in about nine months,", "我们用了大约九个月把计费从单体里拆出来，"],
      ["without a single hour of downtime.", "没有停机一个小时。"],
    ],
  },
  {
    party: "them",
    clauses: [
      ["That's impressive.", "很厉害。"],
      ["So when you say no downtime,", "那你说的不停机，"],
      ["do you mean customers never saw an error,", "是指客户从没看到过报错，"],
      ["or that the errors stayed inside your retry budget?", "还是说错误都在重试预算之内？"],
    ],
  },
  {
    party: "you",
    clauses: [
      ["The second one.", "是后者。"],
      ["Every write was idempotent,", "每次写入都是幂等的，"],
      ["so a retry could never charge a customer twice.", "所以重试不会让客户被扣两次款。"],
    ],
  },
  {
    // About thirty seconds without a pause, the longest a line gets before the
    // engine cuts it (SPEC 1): many clauses, some short, some long.
    party: "them",
    clauses: [
      ["Let me tell you a bit about the incident that made us rethink all of this,", "我先讲讲让我们重新思考这一切的那次事故，"],
      ["because I think it will help you see where we are coming from.", "因为我觉得这能帮你理解我们的出发点。"],
      ["Last spring,", "去年春天，"],
      ["one of our biggest customers ran a migration script on a Friday evening,", "我们最大的一个客户在周五晚上跑了一个迁移脚本，"],
      ["and it sent about forty times the usual traffic to our public API,", "给我们的公开 API 打来了平时大约四十倍的流量，"],
      ["mostly writes,", "大部分是写请求，"],
      ["all of it through the same three proxy addresses.", "全都来自同样的三个代理地址。"],
      ["The gateway saw three very busy clients and throttled them,", "网关只看到三个非常忙的客户端，就把它们限流了，"],
      ["which sounds right,", "听起来没错，"],
      ["except that a few hundred smaller tenants were sitting behind those same addresses,", "可是还有几百个小租户也在同样的地址后面，"],
      ["so for about two hours they could not save anything at all,", "所以大约两个小时里他们什么都保存不了，"],
      ["and our support queue filled up faster than we could read it.", "我们的客服队列涨得比我们看得还快。"],
    ],
  },
  {
    // One long turn without a pause: the strip has to cut it into captions by itself.
    party: "them",
    clauses: [
      ["Okay, let me give you some context on what we are dealing with.", "好，我先讲一下我们这边的情况。"],
      ["We have about four hundred services,", "我们有大约四百个服务，"],
      ["most of them written in Go,", "大部分是用 Go 写的，"],
      ["and a gateway that still does rate limiting per IP address,", "还有一个网关，至今还在按 IP 地址限流，"],
      ["which worked fine five years ago,", "这在五年前没什么问题，"],
      ["but now half of our traffic comes from a handful of large tenants behind the same proxies,", "但现在一半流量来自少数几个大租户，它们都在同一批代理后面，"],
      ["so one noisy customer can starve everyone else.", "所以一个吵闹的客户就能把其他人都饿死。"],
      ["How would you redesign that,", "你会怎么重新设计，"],
      ["and where would you start in the first two weeks?", "头两周会从哪里入手？"],
    ],
  },
  {
    party: "you",
    clauses: [
      ["I'd start by measuring,", "我会先从测量开始，"],
      ["then move the limit from the IP to the tenant,", "然后把限流的维度从 IP 换成租户，"],
      ["with a token bucket per tenant and route.", "每个租户、每条路由一个令牌桶。"],
    ],
  },
  {
    party: "them",
    clauses: [
      ["Makes sense.", "有道理。"],
      ["And what would you measure first?", "那你会先测什么？"],
    ],
  },
];

/**
 * The clauses as the engine reports them. Its tokens carry the space before a
 * word, so every source piece after the first starts with one; the Chinese
 * pieces join without any.
 */
function chunksOf(scriptLine: ScriptLine): TranslationChunk[] {
  return scriptLine.clauses.map(([src, dst], i) => ({ src: i === 0 ? src : ` ${src}`, dst }));
}

/** Milliseconds between two spoken words, and the delays measured on Soniox (SPEC 3.1). */
const WORD_MS = 300;
const CLAUSE_FINAL_MS = 700;
const TRANSLATION_MS = 40;
const LINE_FINAL_MS = 800;
const BETWEEN_LINES_MS = 500;
/** A whole-line translator (an LLM, DeepL) answers this long after the line ends. */
const WHOLE_LINE_TRANSLATION_MS = 1200;

export type CaptionEventName = "transcript_update" | "transcript_final" | "translation_result";

export interface CaptionScriptOptions {
  /**
   * true: the engine translates clause by clause and says which words each
   * piece translates (`chunks`, Soniox). false: the translation comes for the
   * whole line after it ended, without `chunks` (an LLM, DeepL...).
   */
  chunks: boolean;
  /** Index of the script line to start with (the loop then goes on from there). */
  startAt: number;
}

/** How many lines the caption script has (`startAt` goes up to one less). */
export const CAPTION_SCRIPT_LENGTH = CAPTION_SCRIPT.length;

/**
 * Plays the caption script as the backend would send it, in a loop: a line
 * grows word by word (`transcript_update`); with `chunks`, about 0.7 s after
 * each clause its translation arrives (`translation_result` with every chunk
 * of the line so far); a pause ends the line (`transcript_final`, then the
 * final translation). Without `chunks`, the only translation is the whole
 * line's, a moment after it ended. `onEvent` hears every event sent. Returns a
 * function that stops the script.
 */
export function playCaptionScript(
  onEvent: (name: CaptionEventName, text: string) => void,
  options: CaptionScriptOptions = { chunks: true, startAt: 0 },
): () => void {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) run();
    }, ms);
    timers.add(timer);
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => later(ms, resolve));
  const send = (name: CaptionEventName, payload: unknown, text: string) => {
    void emitEvent(name, payload);
    onEvent(name, text);
  };

  const playLine = async (round: number, index: number) => {
    const { party } = CAPTION_SCRIPT[index];
    const chunks = chunksOf(CAPTION_SCRIPT[index]);
    const full = chunks.map((chunk) => chunk.src).join("");
    const base = {
      id: `caption_${round}_${index + 1}`,
      speaker: party === "you" ? "User" : "Them",
      speaker_id: party,
      timestamp_ms: Date.now(),
      confidence: 0.93,
    } satisfies Partial<TranscriptSegment>;
    let spoken = "";
    const translation = (count: number, isFinal: boolean): TranslationResult => ({
      segment_id: base.id,
      // The source can be ahead of the translation: more words were recognised meanwhile.
      original_text: isFinal ? full : spoken,
      translated_text: chunks.slice(0, count).map((chunk) => chunk.dst).join(""),
      source_lang: "en",
      target_lang: "zh",
      provider: options.chunks ? "soniox" : "llm",
      is_final: isFinal,
      ...(options.chunks ? { chunks: chunks.slice(0, count) } : {}),
    });

    for (let c = 0; c < chunks.length; c++) {
      for (const word of chunks[c].src.match(/\s*\S+/g) ?? []) {
        spoken += word;
        send("transcript_update", { segment: { ...base, text: spoken, is_final: false } }, spoken);
        await sleep(WORD_MS);
      }
      // The clause's words become final together, its translation right after.
      // The last clause's comes with the end of the line.
      const upTo = c + 1;
      if (options.chunks && upTo < chunks.length) {
        later(CLAUSE_FINAL_MS + TRANSLATION_MS, () => {
          const event = translation(upTo, false);
          send("translation_result", event, event.translated_text);
        });
      }
    }
    await sleep(LINE_FINAL_MS);
    send("transcript_final", { segment: { ...base, text: full, is_final: true } }, full);
    const last = translation(chunks.length, true);
    if (options.chunks) {
      await sleep(TRANSLATION_MS);
      send("translation_result", last, last.translated_text);
    } else {
      later(WHOLE_LINE_TRANSLATION_MS, () => send("translation_result", last, last.translated_text));
    }
    await sleep(BETWEEN_LINES_MS);
  };

  const play = async () => {
    const first = Math.min(Math.max(0, options.startAt), CAPTION_SCRIPT.length - 1);
    for (let round = 1; !stopped; round++) {
      for (let index = round === 1 ? first : 0; index < CAPTION_SCRIPT.length && !stopped; index++) {
        await playLine(round, index);
      }
      await sleep(1500);
    }
  };
  void play();

  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
    timers.clear();
  };
}
