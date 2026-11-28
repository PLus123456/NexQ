import { expect, it, vi } from "vitest";
import { registerWebSpeechStop, stopWebSpeechRecognition } from "./webSpeechLifecycle";

it("waits for recognition that is still draining", async () => {
  let finish!: () => void;
  const unregister = registerWebSpeechStop(() => new Promise((resolve) => { finish = resolve; }));
  try {
    const done = vi.fn();
    const stopping = stopWebSpeechRecognition().then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    finish();
    await stopping;
    expect(done).toHaveBeenCalledOnce();
  } finally {
    unregister();
  }
});

it("does not stop a recognition session that has unregistered", async () => {
  const stop = vi.fn(async () => {});
  registerWebSpeechStop(stop)();
  await stopWebSpeechRecognition();
  expect(stop).not.toHaveBeenCalled();
});
