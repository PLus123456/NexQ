import { describe, expect, it } from "vitest";
import { prepareMath } from "./answerMath";

describe("prepareMath", () => {
  it("turns \\( … \\) into inline math", () => {
    expect(prepareMath("area \\( \\pi r^2 \\) here")).toBe("area $$\\pi r^2$$ here");
  });

  it("turns a \\[ … \\] on lines of its own into a $$ block", () => {
    expect(prepareMath("so\n\\[\nN = B + rT\n\\]\nand")).toBe("so\n$$\nN = B + rT\n$$\nand");
    expect(prepareMath("\\[ x = 1 \\]")).toBe("$$\nx = 1\n$$");
  });

  it("indents a display formula like the list item it belongs to", () => {
    expect(prepareMath("- item\n  \\[ a = b \\]\n- next")).toBe("- item\n  $$\n  a = b\n  $$\n- next");
    expect(prepareMath("1. step \n   $$x = \\frac12$$")).toBe("1. step \n   $$\n   x = \\frac12\n   $$");
  });

  it("keeps a \\[ … \\] in the middle of a sentence inline", () => {
    expect(prepareMath("then \\[ y \\] follows")).toBe("then $$y$$ follows");
  });

  it("leaves code blocks and inline code alone", () => {
    const fenced = "```latex\n\\( a \\) and $x$ \\[ b \\]\n```";
    expect(prepareMath(fenced)).toBe(fenced);
    expect(prepareMath("~~~\n$5 \\(x\\)\n~~~\nafter \\(y\\)")).toBe("~~~\n$5 \\(x\\)\n~~~\nafter $$y$$");
    expect(prepareMath("run `echo \\(x\\) $HOME` then \\(z\\)")).toBe("run `echo \\(x\\) $HOME` then $$z$$");
    expect(prepareMath("a ``co`de \\(x\\)`` b")).toBe("a ``co`de \\(x\\)`` b");
  });

  it("treats a code fence that is still open as code to the end", () => {
    const open = "text\n```py\nprint('\\(x\\)')";
    expect(prepareMath(open)).toBe(open);
  });

  it("does not read amounts of money as math", () => {
    for (const text of [
      "a plan that costs $5 or $10 a month",
      "between $5-$10",
      "价格是$5，或者$10",
      "$1,000 and $2,000.",
      "only $3",
    ]) {
      expect(prepareMath(text), text).toBe(text);
    }
  });

  it("reads $ … $ as math by Pandoc's rule", () => {
    expect(prepareMath("with $x^2$ and $5")).toBe("with $$x^2$$ and $5");
    expect(prepareMath("keep \\$x\\$ literal")).toBe("keep \\$x\\$ literal");
  });

  it("shows a formula that is not closed yet as typed, backslash included", () => {
    expect(prepareMath("half \\( x^")).toBe("half \\\\( x^");
    expect(prepareMath("so\n\\[\nN = B +")).toBe("so\n\\\\[\nN = B +");
  });

  it("does not let an open $$ block swallow the rest of the answer", () => {
    expect(prepareMath("so\n$$\nN = B +")).toBe("so\n\\$\\$\nN = B +");
    expect(prepareMath("$$ N = B +")).toBe("\\$\\$ N = B +");
    // Closed, it is a block again.
    expect(prepareMath("so\n$$\nN = B\n$$")).toBe("so\n$$\nN = B\n$$");
  });

  it("does not search for a closer beyond the paragraph", () => {
    expect(prepareMath("open \\( x\n\nlater \\) y")).toBe("open \\\\( x\n\nlater \\) y");
  });

  it("leaves an escaped backslash before a bracket alone", () => {
    expect(prepareMath("a \\\\(b)")).toBe("a \\\\(b)");
  });

  it("returns text without math unchanged", () => {
    const text = "# Plan\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |";
    expect(prepareMath(text)).toBe(text);
  });

  it("leaves 4-space and tab indented code blocks untouched while still converting prose math", () => {
    const indented = 'Run this:\n\n    echo "$HOME/$USER"\n\nThen $x^2$ and \\( \\pi r^2 \\).';
    expect(prepareMath(indented)).toBe('Run this:\n\n    echo "$HOME/$USER"\n\nThen $$x^2$$ and $$\\pi r^2$$.');

    const atStart = '    echo "$HOME/$USER"\n\n\\[\nE = mc^2\n\\]';
    expect(prepareMath(atStart)).toBe('    echo "$HOME/$USER"\n\n$$\nE = mc^2\n$$');

    const tabbed = 'Run:\n\n\techo "$HOME/$USER"\n\nArea $a + b$.';
    expect(prepareMath(tabbed)).toBe('Run:\n\n\techo "$HOME/$USER"\n\nArea $$a + b$$.');

    // Inside a list item, 6 spaces (2 for `- ` + 4) is an indented code block,
    // while 4 spaces inside a nested list is continuation prose (still math).
    const insideList = '- item\n\n      echo "$HOME/$USER"\n\n- outer\n  - inner\n\n    $x^2$';
    expect(prepareMath(insideList)).toBe('- item\n\n      echo "$HOME/$USER"\n\n- outer\n  - inner\n\n    $$x^2$$');
  });

  it("leaves fenced code blocks immediately following a list marker untouched while still converting prose math", () => {
    const bulletFence = '- ```bash\n  echo "$HOME/$USER"\n  ```\n\nFormula $x^2$ and \\( a + b \\).';
    expect(prepareMath(bulletFence)).toBe('- ```bash\n  echo "$HOME/$USER"\n  ```\n\nFormula $$x^2$$ and $$a + b$$.');

    const orderedFence = '1. ```sh\n   echo "$HOME/$USER"\n   ```\n\n\\[\nN = B + rT\n\\]';
    expect(prepareMath(orderedFence)).toBe('1. ```sh\n   echo "$HOME/$USER"\n   ```\n\n$$\nN = B + rT\n$$');

    const secondOrderedFence = '1. First step\n2. ```bash\n   echo "$HOME/$USER"\n   ```\n\nAfter $x^2$.';
    expect(prepareMath(secondOrderedFence)).toBe('1. First step\n2. ```bash\n   echo "$HOME/$USER"\n   ```\n\nAfter $$x^2$$.');

    const tildeFence = '- ~~~bash\n  echo "$HOME/$USER"\n  ~~~\n\nAfter \\( y \\).';
    expect(prepareMath(tildeFence)).toBe('- ~~~bash\n  echo "$HOME/$USER"\n  ~~~\n\nAfter $$y$$.');

    const quotedListFence = '> - ```bash\n>   echo "$HOME/$USER"\n>   ```\n\nOutside $z^2$.';
    expect(prepareMath(quotedListFence)).toBe('> - ```bash\n>   echo "$HOME/$USER"\n>   ```\n\nOutside $$z^2$$.');
  });
});
