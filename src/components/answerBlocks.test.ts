import { describe, expect, it } from "vitest";
import { splitBlocks } from "./answerBlocks";

describe("splitBlocks", () => {
  it("cuts at blank lines before a block that starts in column 0, and loses nothing", () => {
    const text = "# Title\n\nFirst paragraph.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> quote\n";
    const blocks = splitBlocks(text);
    expect(blocks).toEqual(["# Title\n\n", "First paragraph.\n\n", "| a | b |\n| - | - |\n| 1 | 2 |\n\n", "> quote\n"]);
    expect(blocks.join("")).toBe(text);
  });

  it("keeps a list whole, also a loose one, and its continuation paragraphs", () => {
    const list = "1. one\n\n2. two\n\n   more about two\n\n- other\n";
    expect(splitBlocks(list)).toEqual([list]);
  });

  it("never cuts inside a code fence or a $$ block", () => {
    const text = "```\na\n\nb\n```\n\n$$\nx\n\ny\n$$\n\nend";
    expect(splitBlocks(text)).toEqual(["```\na\n\nb\n```\n\n", "$$\nx\n\ny\n$$\n\n", "end"]);
  });

  it("does not cut an answer with link definitions or footnotes", () => {
    const text = "See [x].\n\nMore.\n\n[x]: https://example.com\n";
    expect(splitBlocks(text)).toEqual([text]);
  });
});
