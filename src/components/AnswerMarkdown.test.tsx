import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => shell);

import { AnswerMarkdown } from "./AnswerMarkdown";

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
});
