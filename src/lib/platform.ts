// Which OS the app runs on, from the webview's user agent (synchronous, and
// works in tests). WKWebView reports "Macintosh", WebView2 "Windows".

export type Platform = "macos" | "windows" | "linux" | "unknown";

export function currentPlatform(): Platform {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux/i.test(ua)) return "linux";
  return "unknown";
}

export function isMac(): boolean {
  return currentPlatform() === "macos";
}

export function isWindows(): boolean {
  return currentPlatform() === "windows";
}
