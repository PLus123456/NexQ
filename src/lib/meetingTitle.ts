/** "2026-10-23 15:02", like the backend's default meeting name. */
function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * NexQ meeting name for a detected call: the call's title (or the app's name
 * when it shows none) in front of the usual "Meeting <date time>".
 * "Weekly sync" → "Weekly sync — Meeting 2026-10-23 15:02".
 */
export function composeMeetingTitle(prefix: string | null | undefined, now = new Date()): string {
  const base = `Meeting ${stamp(now)}`; // i18n-ignore: stored default title, same as the backend's
  const p = prefix?.replace(/\s+/g, " ").trim();
  return p ? `${p} — ${base}` : base;
}
