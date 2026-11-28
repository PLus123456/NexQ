// The launcher's recognizers stay registered while their final results drain.
const stops = new Set<() => Promise<void>>();

export function registerWebSpeechStop(stop: () => Promise<void>): () => void {
  stops.add(stop);
  return () => { stops.delete(stop); };
}

/** Gracefully stop this webview's recognition and wait for its last results. */
export async function stopWebSpeechRecognition(): Promise<void> {
  await Promise.all([...stops].map((stop) => stop()));
}
