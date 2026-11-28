/**
 * Math delimiters of a model's answer, rewritten for remark-math before the
 * Markdown is parsed.
 *
 * Models write LaTeX as `\( … \)` and `\[ … \]` (and sometimes `$ … $` or
 * `$$ … $$`). Markdown reads `\(` as an escaped bracket, and a bare `$` is far
 * more often money than math. So the answer is rewritten into one form that
 * remark-math (with `singleDollarTextMath: false`) reads without guessing:
 *
 * - inline math becomes `$$…$$` inside the line;
 * - display math becomes a `$$` block on lines of its own;
 * - `$ … $` counts as math only by Pandoc's rule (no space after the opening
 *   `$`, no space before the closing one, no digit right after it), so
 *   "$5 and $10" stays text;
 * - code blocks and inline code are copied untouched;
 * - a formula that is not closed yet (the answer is still streaming) is shown
 *   as typed, with its delimiters visible, and rendered once it closes. An open
 *   `$$` block in particular must not swallow the rest of the answer.
 *
 * Nothing searches across a blank line: a formula never spans paragraphs, and
 * an opener without its closer in the same paragraph is left as text.
 */

/** What may stand before a block on its line: indentation, quote markers, a list marker. */
const LINE_PREFIX = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?$/;

const FENCE_MARKER = /^(`{3,}|~{3,})/;
const LIST_MARKER = /^([-*+]|(\d{1,9})[.)])(?=[ \t]|$)/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ATX_HEADING = /^#{1,6}(?:[ \t]|$)/;
const SETEXT_UNDERLINE = /^(?:=+|-+)[ \t]*$/;
// A price followed by ordinary words can run right up to a second opener
// when the formula sits in parentheses or follows text without spaces.
const PRICE_BEFORE_PROSE = /^\d+(?:[,.]\d+)*(?:[\t \p{P}]+\p{L}{2}|[\t \p{P}]*[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/u;

type Container = { kind: "quote" } | { kind: "list"; indent: number };

interface LineCursor {
  raw: string;
  pos: number;
  col: number;
  pad: number;
}

function peekIndent(cur: LineCursor): { cols: number; nextPos: number } {
  let cols = cur.pad;
  let col = cur.col + cur.pad;
  let pos = cur.pos;
  while (pos < cur.raw.length) {
    const ch = cur.raw[pos];
    if (ch === " ") {
      cols += 1;
      col += 1;
      pos += 1;
    } else if (ch === "\t") {
      const width = 4 - (col % 4);
      cols += width;
      col += width;
      pos += 1;
    } else {
      break;
    }
  }
  return { cols, nextPos: pos };
}

function consumeCols(cur: LineCursor, count: number): void {
  let left = count;
  if (cur.pad > 0) {
    const take = Math.min(cur.pad, left);
    cur.pad -= take;
    cur.col += take;
    left -= take;
  }
  while (left > 0 && cur.pos < cur.raw.length) {
    const ch = cur.raw[cur.pos];
    if (ch === " ") {
      cur.pos += 1;
      cur.col += 1;
      left -= 1;
    } else if (ch === "\t") {
      const width = 4 - (cur.col % 4);
      cur.pos += 1;
      if (width <= left) {
        cur.col += width;
        left -= width;
      } else {
        cur.col += left;
        cur.pad = width - left;
        left = 0;
      }
    } else {
      break;
    }
  }
}

function isBlank(cur: LineCursor): boolean {
  return peekIndent(cur).nextPos >= cur.raw.length;
}

function matchQuote(cur: LineCursor): boolean {
  const { cols, nextPos } = peekIndent(cur);
  if (cols > 3 || cur.raw[nextPos] !== ">") return false;
  consumeCols(cur, cols);
  cur.pos += 1;
  cur.col += 1;
  if (peekIndent(cur).cols >= 1) consumeCols(cur, 1);
  return true;
}

function matchListMarker(cur: LineCursor, inParagraph: boolean): number | null {
  const { cols, nextPos } = peekIndent(cur);
  if (cols > 3) return null;
  const rest = cur.raw.slice(nextPos);
  if (THEMATIC_BREAK.test(rest)) return null;
  const match = LIST_MARKER.exec(rest);
  if (!match) return null;
  const marker = match[1];
  const digits = match[2];
  const afterPos = nextPos + marker.length;
  const afterCur: LineCursor = { raw: cur.raw, pos: afterPos, col: cur.col + cols + marker.length, pad: 0 };
  const afterIndent = peekIndent(afterCur);
  const emptyItem = afterIndent.nextPos >= cur.raw.length;
  if (inParagraph && (emptyItem || (digits !== undefined && Number(digits) !== 1))) {
    return null;
  }
  consumeCols(cur, cols);
  cur.pos += marker.length;
  cur.col += marker.length;
  const extraSpaces = emptyItem || afterIndent.cols >= 5 ? 1 : afterIndent.cols;
  if (!emptyItem) consumeCols(cur, extraSpaces);
  return cols + marker.length + extraSpaces;
}

/** The indentation the lines of a block need to stay where its first line is (list item, quote). */
function continuationIndent(prefix: string): string {
  return prefix.replace(/(?:[-*+]|\d{1,9}[.)])([ \t]+)$/, (marker) => " ".repeat(marker.length));
}

/** The answer, with its math delimiters in the form remark-math reads. Never throws. */
export function prepareMath(markdown: string): string {
  if (!/[\\$]/.test(markdown)) return markdown;
  try {
    return splitCode(markdown)
      .map((part) => (part.code ? part.text : convertText(part.text)))
      .join("");
  } catch {
    return markdown;
  }
}

/** The text cut into code blocks (fenced and indented) and everything else; joined back it is the same text. */
function splitCode(markdown: string): Array<{ code: boolean; text: string }> {
  const lines = markdown.split(/(?<=\n)/);
  const parts: Array<{ code: boolean; text: string }> = [];
  let buf = "";
  let bufCode = false;
  const pushLine = (isCode: boolean, line: string) => {
    if (buf && bufCode !== isCode) {
      parts.push({ code: bufCode, text: buf });
      buf = "";
    }
    bufCode = isCode;
    buf += line;
  };

  let containers: Container[] = [];
  let fence: { char: string; length: number; containers: Container[] } | null = null;
  let inParagraph = false;

  for (const line of lines) {
    const raw = line.replace(/\r?\n$/, "");
    const cur: LineCursor = { raw, pos: 0, col: 0, pad: 0 };

    // Match open containers (blockquotes and list items) from outer to inner.
    let matched = 0;
    for (const c of containers) {
      if (c.kind === "quote") {
        if (!matchQuote(cur)) break;
        matched++;
      } else {
        if (isBlank(cur)) break;
        if (peekIndent(cur).cols < c.indent) break;
        consumeCols(cur, c.indent);
        matched++;
      }
    }

    if (fence) {
      const neededQuotes = fence.containers.filter((c) => c.kind === "quote").length;
      const matchedQuotes = containers.slice(0, matched).filter((c) => c.kind === "quote").length;
      const lineBlank = isBlank(cur);
      const stillInFence =
        matchedQuotes === neededQuotes &&
        (lineBlank || matched >= fence.containers.length);

      if (stillInFence) {
        pushLine(true, line);
        if (!lineBlank) {
          const { cols, nextPos } = peekIndent(cur);
          const rest = cur.raw.slice(nextPos);
          const close = cols <= 3 ? FENCE_MARKER.exec(rest) : null;
          if (
            close &&
            close[1][0] === fence.char &&
            close[1].length >= fence.length &&
            rest.slice(close[0].length).trim() === ""
          ) {
            fence = null;
            inParagraph = false;
          }
        }
        continue;
      }
      fence = null;
      inParagraph = false;
    }

    if (isBlank(cur)) {
      let keep = matched;
      while (keep < containers.length && containers[keep].kind === "list") keep++;
      containers = containers.slice(0, keep);
      inParagraph = false;
      pushLine(false, line);
      continue;
    }

    let poppedList = false;
    if (matched < containers.length) {
      poppedList = containers.slice(matched).some((c) => c.kind === "list");
      containers = containers.slice(0, matched);
    }

    let isCode = false;
    while (true) {
      const { cols, nextPos } = peekIndent(cur);
      if (nextPos >= cur.raw.length) {
        inParagraph = false;
        break;
      }

      if (cols >= 4 && !inParagraph) {
        isCode = true;
        inParagraph = false;
        break;
      }

      if (cols <= 3 && cur.raw[nextPos] === ">") {
        matchQuote(cur);
        containers.push({ kind: "quote" });
        inParagraph = false;
        poppedList = false;
        continue;
      }

      const listIndent = matchListMarker(cur, inParagraph && !poppedList);
      if (listIndent !== null) {
        containers.push({ kind: "list", indent: listIndent });
        inParagraph = false;
        poppedList = false;
        continue;
      }

      const rest = cur.raw.slice(nextPos);
      const open = cols <= 3 ? FENCE_MARKER.exec(rest) : null;
      // A backtick fence's info string cannot hold a backtick; otherwise it is inline code.
      if (open && !(open[1][0] === "`" && rest.slice(open[0].length).includes("`"))) {
        fence = { char: open[1][0], length: open[1].length, containers: containers.slice() };
        isCode = true;
        inParagraph = false;
        break;
      }

      if (
        cols <= 3 &&
        (ATX_HEADING.test(rest) ||
          THEMATIC_BREAK.test(rest) ||
          (inParagraph && SETEXT_UNDERLINE.test(rest)))
      ) {
        inParagraph = false;
      } else {
        inParagraph = true;
      }
      break;
    }

    pushLine(isCode, line);
  }

  if (buf) parts.push({ code: bufCode, text: buf });
  return parts;
}

/** The end of the paragraph that holds `from`: the next blank line, or the end of the text. */
function paragraphEnd(text: string, from: number): number {
  const blank = /\n[ \t>]*\n/g;
  blank.lastIndex = from;
  const match = blank.exec(text);
  return match ? match.index : text.length;
}

/** Where the line holding `at` starts. */
function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

/** Whether only whitespace follows `at` up to the end of its line. */
function restOfLineEmpty(text: string, at: number): boolean {
  const end = text.indexOf("\n", at);
  return text.slice(at, end === -1 ? text.length : end).trim() === "";
}

/** The number of `char` in a row starting at `at`. */
function runLength(text: string, at: number, char: string): number {
  let n = 0;
  while (text[at + n] === char) n++;
  return n;
}

/** The next `\` + `close` (an odd run of backslashes before it) in [from, end), or -1. */
function findEscapedCloser(text: string, from: number, end: number, close: string): number {
  for (let i = text.indexOf("\\" + close, from); i !== -1 && i < end; i = text.indexOf("\\" + close, i + 1)) {
    let slashes = 1;
    while (i - slashes >= from && text[i - slashes] === "\\") slashes++;
    if (slashes % 2 === 1) return i;
  }
  return -1;
}

/** A display formula as a `$$` block on lines of its own, indented like the line it starts on. */
function displayBlock(tex: string, prefix: string): string {
  const indent = continuationIndent(prefix);
  const quoted = indent.includes(">");
  let lines = tex.split("\n").map((line) => (quoted ? line.replace(/^[ \t]*(?:>[ \t]?)*/, "") : line));
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const common = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  lines = lines.map((line) => indent + line.slice(Number.isFinite(common) ? common : 0).trimEnd());
  return `$$\n${lines.join("\n")}\n${indent}$$`;
}

/** Text outside code blocks, with its math rewritten. */
function convertText(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === "`") {
      // Inline code: copied as is up to the closing run of the same length.
      const n = runLength(text, i, "`");
      const end = paragraphEnd(text, i);
      let close = -1;
      for (let j = text.indexOf("`".repeat(n), i + n); j !== -1 && j < end; j = text.indexOf("`".repeat(n), j + 1)) {
        if (text[j - 1] !== "`" && text[j + n] !== "`") {
          close = j;
          break;
        }
        j += runLength(text, j, "`") - 1;
      }
      const stop = close === -1 ? i + n : close + n;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === "\\") {
      const n = runLength(text, i, "\\");
      const next = text[i + n];
      if (n % 2 === 1 && (next === "(" || next === "[")) {
        out += text.slice(i, i + n - 1);
        const open = i + n - 1;
        const display = next === "[";
        const closer = display ? "]" : ")";
        const end = paragraphEnd(text, open);
        const close = findEscapedCloser(text, open + 2, end, closer);
        const tex = close === -1 ? "" : text.slice(open + 2, close);
        if (close === -1 || tex.trim() === "") {
          // Not closed yet (or empty): shown as typed, backslash included.
          out += "\\\\" + next;
          i = open + 2;
          continue;
        }
        const start = lineStart(text, open);
        const prefix = text.slice(start, open);
        if (display && LINE_PREFIX.test(prefix) && restOfLineEmpty(text, close + 2)) {
          out += displayBlock(tex, prefix);
        } else {
          out += `$$${tex.trim()}$$`;
        }
        i = close + 2;
        continue;
      }
      // Escapes (`\$`, `\\`, `\*` …) stay as they are.
      out += text.slice(i, i + n + (next === undefined ? 0 : 1));
      i += n + (next === undefined ? 0 : 1);
      continue;
    }

    if (ch === "$") {
      const n = runLength(text, i, "$");
      const end = paragraphEnd(text, i);
      if (n >= 2) {
        const start = lineStart(text, i);
        const prefix = text.slice(start, i);
        const atBlockStart = LINE_PREFIX.test(prefix);
        if (atBlockStart && restOfLineEmpty(text, i + n)) {
          // A `$$` block: copied as is when its closing line has come, else shown as text.
          const closing = /\n[ \t>]*\${2,}[ \t]*(?=\n|$)/g;
          closing.lastIndex = i + n;
          const match = closing.exec(text);
          if (match) {
            out += text.slice(i, match.index + match[0].length);
            i = match.index + match[0].length;
          } else {
            out += "\\$".repeat(n);
            i += n;
          }
          continue;
        }
        const close = text.indexOf("$$", i + n);
        if (close === -1 || close >= end) {
          // Unclosed. At the start of a line remark-math would open a block with it.
          out += atBlockStart ? "\\$".repeat(n) : text.slice(i, i + n);
          i += n;
          continue;
        }
        const tex = text.slice(i + n, close);
        const after = close + runLength(text, close, "$");
        if (atBlockStart && restOfLineEmpty(text, after) && tex.trim() !== "") {
          out += displayBlock(tex, prefix);
        } else {
          out += text.slice(i, after);
        }
        i = after;
        continue;
      }
      // A single `$`: math only by Pandoc's rule, so amounts of money stay text.
      const close = findDollarCloser(text, i, end);
      const startsNewFormula = close !== -1 && PRICE_BEFORE_PROSE.test(text.slice(i + 1, close)) &&
        findDollarCloser(text, close, end) !== -1;
      if (close === -1 || startsNewFormula) {
        out += "$";
        i += 1;
        continue;
      }
      out += `$$${text.slice(i + 1, close)}$$`;
      i = close + 1;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/** The `$` that closes the one at `open` by Pandoc's rule, or -1 when it opens nothing. */
function findDollarCloser(text: string, open: number, end: number): number {
  const first = text[open + 1];
  if (first === undefined || /\s/.test(first)) return -1;
  for (let j = open + 1; j < end; j++) {
    const c = text[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c !== "$") continue;
    // A delimiter that cannot close may open the next formula. Do not look
    // past it and pair a price with that formula's closing delimiter.
    return text[j + 1] !== "$" && !/\s/.test(text[j - 1]) && !/[0-9]/.test(text[j + 1] ?? "") ? j : -1;
  }
  return -1;
}
