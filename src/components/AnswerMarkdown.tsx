import { useMemo, type CSSProperties } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { withoutImages } from "../lib/answerMarkdown";

const REMARK_PLUGINS = [remarkGfm];

export interface AnswerMarkdownProps {
  /** The model's text, as Markdown. */
  content: string;
  /** The text is still arriving. Accepted so call sites can already say so; nothing depends on it yet. */
  streaming?: boolean;
  /** Classes for the wrapper, after the stable `answer-md`. */
  className?: string;
  /** Font size, colour, line height… of the wrapper: the text inherits them. */
  style?: CSSProperties;
  /** Element overrides of the call site. Images and links stay held back whatever is passed. */
  components?: Components;
}

/**
 * Text written by a model, rendered as Markdown. Every place that shows model
 * output goes through this component (never `ReactMarkdown` directly), so
 * typography, math and the protections live in one file. An image never
 * loads and a link opens only after the user confirms (lib/answerMarkdown).
 */
export function AnswerMarkdown({ content, className, style, components }: AnswerMarkdownProps) {
  const safeComponents = useMemo(() => withoutImages(components), [components]);
  return (
    <div className={className ? `answer-md ${className}` : "answer-md"} style={style}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={safeComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
