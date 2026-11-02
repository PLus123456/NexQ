// Hosts the user agreed to send document text to, per feature: a
// per-computer convenience in localStorage (asked again when storage is
// unavailable).

const STORAGE_KEYS = {
  embedding: "nexq.rag.embeddingConsentHosts",
  rerank: "nexq.rag.rerankConsentHosts",
} as const;

export type ConsentKind = keyof typeof STORAGE_KEYS;

export function consentedHosts(kind: ConsentKind): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[kind]);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function rememberConsent(kind: ConsentKind, host: string) {
  try {
    localStorage.setItem(STORAGE_KEYS[kind], JSON.stringify([...new Set([...consentedHosts(kind), host])]));
  } catch {
    // Private mode or blocked storage: ask again next time.
  }
}
