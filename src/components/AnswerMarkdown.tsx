import { memo, useMemo, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import "./AnswerMarkdown.css";
import { withoutImages } from "../lib/answerMarkdown";
import { prepareMath } from "./answerMath";
import { splitBlocks } from "./answerBlocks";

// `$…$` is never read as math by remark-math itself: prepareMath decides what
// is math (amounts of money are not) and hands it over as `$$…$$`.
const REMARK_PLUGINS = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]] as const;
// Bad LaTeX shows as its source in the error colour, never throws; no \href, \url or \htmlClass.
const REHYPE_PLUGINS = [[rehypeKatex, { throwOnError: false, trust: false, strict: "ignore", output: "htmlAndMathml" }]] as const;

/** Wide tables scroll sideways inside their own box instead of widening the answer. */
const BASE_COMPONENTS: Components = {
  table: ({ children }) => (
    <div className="answer-md-table">
      <table>{children}</table>
    </div>
  ),
};

export interface AnswerMarkdownProps {
  /** The model's text, as Markdown. */
  content: string;
  /** The text is still arriving: only the last block is parsed again on each update. */
  streaming?: boolean;
  /** Classes for the wrapper, after the stable `answer-md`. */
  className?: string;
  /** Font size, colour, line height… of the wrapper: the text inherits them. */
  style?: CSSProperties;
  /** Element overrides of the call site. Images and links stay held back whatever is passed. */
  components?: Components;
}

/** One piece of the answer, rendered on its own so a finished piece is not parsed again. */
const Block = memo(function Block({ markdown, components }: { markdown: string; components: Components }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS as never}
      rehypePlugins={REHYPE_PLUGINS as never}
      components={components}
    >
      {markdown}
    </ReactMarkdown>
  );
});

/**
 * Text written by a model, rendered as Markdown. Every place that shows model
 * output goes through this component (never `ReactMarkdown` directly), so
 * typography, math and the protections live in one file. An image never
 * loads and a link opens only after the user confirms (lib/answerMarkdown).
 *
 * Typography is AnswerMarkdown.css, sized in `em` so the caller's font size,
 * colour and line height (the overlay's text settings) carry through; an
 * element the caller styles with its own classes keeps the caller's look.
 * Math: `\( … \)`, `\[ … \]` and `$ … $` are rewritten by prepareMath and
 * rendered by KaTeX, whose CSS and fonts are bundled (no CDN).
 *
 * While streaming, the answer is cut into top-level blocks (splitBlocks) and
 * each one is memoised, so a new token parses only the last block, not the
 * whole answer again.
 */
export function AnswerMarkdown({ content, streaming, className, style, components }: AnswerMarkdownProps) {
  const safeComponents = useMemo(() => withoutImages({ ...BASE_COMPONENTS, ...components }), [components]);
  const prepared = useMemo(() => prepareMath(content), [content]);
  const blocks = useMemo(() => (streaming ? splitBlocks(prepared) : [prepared]), [prepared, streaming]);
  let body: ReactNode;
  if (blocks.length === 1) {
    body = <Block markdown={blocks[0]} components={safeComponents} />;
  } else {
    // A block keeps its key (its position) as the answer grows, so React keeps it.
    body = blocks.map((markdown, index) => <Block key={index} markdown={markdown} components={safeComponents} />);
  }
  return (
    <div className={className ? `answer-md ${className}` : "answer-md"} style={style}>
      {body}
    </div>
  );
}
