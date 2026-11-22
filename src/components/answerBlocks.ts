/**
 * A streaming answer cut into top-level Markdown blocks, so that each block can
 * be parsed and rendered once and only the growing last block is parsed again
 * on every token.
 *
 * The answer is cut only where a cut cannot change how it renders: at a blank
 * line followed by a line that starts in column 0 and does not start a list
 * item. Such a line always ends whatever list, quote or paragraph came before
 * it, so the blocks rendered one after another give the same elements as the
 * whole text rendered at once. Never inside a code fence or a `$$` block, and
 * not at all when the answer has link reference definitions or footnotes,
 * which reach across blocks.
 */

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const MATH_FENCE = /^[ \t]*\$\$[ \t]*\r?\n?$/;
/** A line that may stand after a blank line without continuing the block before it. */
const BLOCK_START = /^(?![ \t]|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$))\S/;
/** `[label]: url` or `[^note]: text`: a definition the whole document can refer to. */
const DEFINITION = /^[ \t]{0,3}\[[^\]\n]+\]:/m;

export function splitBlocks(markdown: string): string[] {
  if (DEFINITION.test(markdown)) return [markdown];
  const lines = markdown.split(/(?<=\n)/);
  const blocks: string[] = [];
  let current = "";
  let fence: { char: string; length: number } | null = null;
  let math = false;
  let blankBefore = false;
  for (const line of lines) {
    const blank = line.trim() === "";
    if (!fence && !math && blankBefore && !blank && BLOCK_START.test(line) && current.trim() !== "") {
      blocks.push(current);
      current = "";
    }
    current += line;
    if (fence) {
      const close = FENCE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length && line.slice(close[0].length).trim() === "") fence = null;
    } else if (math) {
      if (MATH_FENCE.test(line)) math = false;
    } else {
      const open = FENCE.exec(line);
      if (open && !(open[1][0] === "`" && line.slice(open[0].length).includes("`"))) {
        fence = { char: open[1][0], length: open[1].length };
      } else if (MATH_FENCE.test(line)) {
        math = true;
      }
    }
    blankBefore = blank;
  }
  if (current) blocks.push(current);
  return blocks;
}
