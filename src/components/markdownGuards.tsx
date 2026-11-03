import type { Components } from "react-markdown";
import { open as openExternal } from "@tauri-apps/plugin-shell";

/**
 * Markdown overrides for model output. The text can carry instructions planted
 * in a transcript or document, so images are never loaded (their URL could
 * carry data out; the alt text shows instead) and links open in the browser,
 * never in the app's own window.
 */
export const mdGuards: Components = {
  img: ({ alt }) => (alt ? <span className="text-foreground/60">[{alt}]</span> : null),
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && /^https?:\/\//i.test(href)) void openExternal(href);
      }}
      className="text-primary underline underline-offset-2"
    >
      {children}
    </a>
  ),
};
