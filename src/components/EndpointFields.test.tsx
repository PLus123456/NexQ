import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EndpointFields, type EndpointFieldsProps, type EndpointFieldsValue } from "./EndpointFields";
import { changeUiLanguage } from "../i18n";
import { ENDPOINT_PATHS, NO_AUTH, type AuthConfig } from "../lib/endpoint";

const BEARER: AuthConfig = { mode: "bearer", header_name: "", prefix: "" };

type HarnessProps = Omit<EndpointFieldsProps, "value" | "onChange" | "path"> & {
  initial?: Partial<EndpointFieldsValue>;
  path?: string;
  onValue?: (value: EndpointFieldsValue) => void;
};

/** EndpointFields with its value in state, like a settings page. */
function Harness({ initial, path = ENDPOINT_PATHS.chatCompletions, onValue, ...props }: HarnessProps) {
  const [value, setValue] = useState<EndpointFieldsValue>({ baseUrl: "", auth: NO_AUTH, headers: [], ...initial });
  return (
    <EndpointFields
      {...props}
      path={path}
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
    />
  );
}

const baseUrlInput = () => screen.getByLabelText<HTMLInputElement>("Base URL");

/** Latin words in the rendered text and labels that aren't in `keep`. */
function untranslatedWords(root: HTMLElement, keep: readonly string[]): string[] {
  const texts: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode.textContent ?? "");
  root.querySelectorAll("*").forEach((el) => {
    for (const attr of ["title", "aria-label", "placeholder"]) {
      const value = el.getAttribute(attr);
      if (value) texts.push(value);
    }
  });
  return texts.flatMap((text) => text.match(/[A-Za-z]{2,}/g) ?? []).filter((word) => !keep.includes(word));
}

afterEach(async () => {
  cleanup();
  await changeUiLanguage("en");
});

describe("EndpointFields: Base URL", () => {
  it("previews the actual request URLs as the Base URL changes", () => {
    render(
      <Harness
        initial={{ baseUrl: "https://api.openai.com/v1/" }}
        extraPaths={[{ label: "Models", path: ENDPOINT_PATHS.models }]}
      />,
    );
    expect(screen.getByText("Actual request URL")).toBeInTheDocument();
    expect(screen.getByText("https://api.openai.com/v1/chat/completions")).toBeInTheDocument();
    expect(screen.getByText("Models")).toBeInTheDocument();
    expect(screen.getByText("https://api.openai.com/v1/models")).toBeInTheDocument();

    fireEvent.change(baseUrlInput(), { target: { value: "https://open.bigmodel.cn/api/paas/v4" } });
    expect(screen.getByText("https://open.bigmodel.cn/api/paas/v4/chat/completions")).toBeInTheDocument();
    expect(screen.getByText("https://open.bigmodel.cn/api/paas/v4/models")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add /v1" })).not.toBeInTheDocument();
  });

  it("recognizes a full URL typed as the Base URL", () => {
    render(<Harness initial={{ baseUrl: "https://gw.example.com/llm/chat/completions" }} />);
    expect(screen.getByText("https://gw.example.com/llm/chat/completions")).toBeInTheDocument();
    expect(screen.getByText("Recognized as a full URL, so /chat/completions isn't added again.")).toBeInTheDocument();
  });

  it("cuts a pasted full URL back to its base", () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} extraPaths={[{ label: "Models", path: ENDPOINT_PATHS.models }]} />);
    fireEvent.paste(baseUrlInput(), {
      clipboardData: { getData: () => "https://gw.example.com/llm/chat/completions" },
    });
    expect(baseUrlInput()).toHaveValue("https://gw.example.com/llm");
    expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl: "https://gw.example.com/llm" }));
    expect(screen.getByText("Recognized as a full URL: removed /chat/completions from the end.")).toBeInTheDocument();
    expect(screen.getByText("https://gw.example.com/llm/models")).toBeInTheDocument();

    // The notice goes with the next edit.
    fireEvent.change(baseUrlInput(), { target: { value: "https://gw.example.com/llm2" } });
    expect(screen.queryByText(/removed \/chat\/completions/)).not.toBeInTheDocument();
  });

  it("offers to add /v1 when the Base URL has no path", () => {
    render(<Harness initial={{ baseUrl: "http://192.168.1.10:8000" }} path={ENDPOINT_PATHS.audioTranscriptions} />);
    expect(screen.getByText("http://192.168.1.10:8000/audio/transcriptions")).toBeInTheDocument();
    expect(screen.getByText("Most OpenAI-compatible services need a version prefix such as /v1.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add /v1" }));
    expect(baseUrlInput()).toHaveValue("http://192.168.1.10:8000/v1");
    expect(screen.getByText("http://192.168.1.10:8000/v1/audio/transcriptions")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add /v1" })).not.toBeInTheDocument();
  });

  it("leaves the version hint out when versionHint is false", () => {
    render(<Harness initial={{ baseUrl: "http://192.168.1.10:8000" }} versionHint={false} />);
    expect(screen.getByText("http://192.168.1.10:8000/chat/completions")).toBeInTheDocument();
    expect(screen.queryByText(/version prefix/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add /v1" })).not.toBeInTheDocument();
  });

  it("explains a missing scheme and fixes it in one click", () => {
    render(<Harness initial={{ baseUrl: "localhost:11434/v1" }} />);
    expect(baseUrlInput()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("The address must start with http:// or https://.")).toBeInTheDocument();
    expect(screen.queryByText("Actual request URL")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use http://localhost:11434/v1" }));
    expect(baseUrlInput()).toHaveValue("http://localhost:11434/v1");
    expect(baseUrlInput()).not.toHaveAttribute("aria-invalid");
    expect(screen.getByText("http://localhost:11434/v1/chat/completions")).toBeInTheDocument();
  });

  it("names an unsupported scheme, and says nothing about a blank field", () => {
    const props = { onChange: () => {}, path: ENDPOINT_PATHS.models };
    const value = (baseUrl: string): EndpointFieldsValue => ({ baseUrl, auth: NO_AUTH, headers: [] });
    const { rerender } = render(<EndpointFields {...props} value={value("ftp://files.example.com")} />);
    expect(screen.getByText("ftp:// isn't supported. Use http:// or https://.")).toBeInTheDocument();

    rerender(<EndpointFields {...props} value={value("   ")} />);
    expect(baseUrlInput()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(/isn't supported|must start with|valid address|Actual request URL/)).not.toBeInTheDocument();
  });
});

describe("EndpointFields: auth and API key", () => {
  it("builds a custom auth header from its name and prefix", () => {
    render(<Harness initial={{ baseUrl: "https://x.openai.azure.com/openai" }} />);
    const group = screen.getByRole("group", { name: "Authentication" });
    expect(within(group).getByRole("button", { name: "None" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(group).getByRole("button", { name: "Custom header" }));
    expect(within(group).getByRole("button", { name: "Custom header" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Enter a header name.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "api-key" } });
    expect(screen.queryByText("Enter a header name.")).not.toBeInTheDocument();
    expect(screen.getByText("api-key: <API Key>")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Value prefix (optional)"), { target: { value: "Token" } });
    expect(screen.getByText("api-key: Token <API Key>")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "api key" } });
    expect(screen.getByLabelText("Header name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Not a valid header name: no spaces, colons or other separators.")).toBeInTheDocument();

    fireEvent.click(within(group).getByRole("button", { name: "Bearer token" }));
    expect(screen.queryByLabelText("Header name")).not.toBeInTheDocument();
    expect(screen.getByText("Authorization: Bearer <API Key>")).toBeInTheDocument();
  });

  it("offers only the auth modes asked for", () => {
    render(<Harness authModes={["none", "bearer"]} />);
    const group = screen.getByRole("group", { name: "Authentication" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["None", "Bearer token"]);
  });

  it("hands the typed key over on blur or Enter and never shows a saved one", () => {
    const onSecretChange = vi.fn();
    render(
      <Harness
        initial={{ baseUrl: "https://api.openai.com/v1", auth: BEARER }}
        secretStatus={{ saved: true, hint: "ab12" }}
        onSecretChange={onSecretChange}
      />,
    );
    const key = screen.getByLabelText<HTMLInputElement>("API Key");
    expect(key).toHaveAttribute("type", "password");
    expect(key).toHaveAttribute("placeholder", "Saved …ab12");
    expect(key).toHaveValue("");

    fireEvent.change(key, { target: { value: "  sk-new  " } });
    fireEvent.blur(key);
    expect(onSecretChange).toHaveBeenCalledWith("sk-new");
    expect(key).toHaveValue("");

    fireEvent.change(key, { target: { value: "sk-other" } });
    fireEvent.keyDown(key, { key: "Enter" });
    expect(onSecretChange).toHaveBeenLastCalledWith("sk-other");
    expect(key).toHaveValue("");

    // Nothing typed: nothing handed over.
    fireEvent.blur(key);
    expect(onSecretChange).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onSecretChange).toHaveBeenLastCalledWith(null);
  });

  it("shows the key input only with secret props and an auth mode that sends it", () => {
    const props = { onChange: () => {}, path: ENDPOINT_PATHS.chatCompletions };
    const value = (auth: AuthConfig): EndpointFieldsValue => ({ baseUrl: "https://h.example/v1", auth, headers: [] });
    const { rerender } = render(<EndpointFields {...props} value={value(NO_AUTH)} onSecretChange={() => {}} />);
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();

    rerender(<EndpointFields {...props} value={value(BEARER)} />);
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();

    rerender(<EndpointFields {...props} value={value(BEARER)} secretStatus={{ saved: false }} onSecretChange={() => {}} />);
    expect(screen.getByLabelText("API Key")).toHaveAttribute("placeholder", "Enter the API key");
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();

    rerender(<EndpointFields {...props} value={value(BEARER)} secretStatus={{ saved: true }} onSecretChange={() => {}} />);
    expect(screen.getByLabelText("API Key")).toHaveAttribute("placeholder", "Saved");
  });
});

describe("EndpointFields: custom headers", () => {
  it("adds, checks and removes custom headers", () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    const names = () => screen.getAllByLabelText<HTMLInputElement>("Name");
    const values = () => screen.getAllByLabelText<HTMLInputElement>("Value");

    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    expect(names()).toHaveLength(1);
    expect(names()[0]).toHaveFocus();

    fireEvent.change(names()[0], { target: { value: "bad name" } });
    expect(names()[0]).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Not a valid header name.")).toBeInTheDocument();
    fireEvent.change(names()[0], { target: { value: "X-Org" } });
    fireEvent.change(values()[0], { target: { value: "acme" } });
    expect(names()[0]).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Not a valid header name.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    expect(names()[1]).toHaveFocus();
    fireEvent.change(names()[1], { target: { value: "X-Trace" } });
    expect(onValue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headers: [
          { name: "X-Org", value: "acme" },
          { name: "X-Trace", value: "" },
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove header X-Org" }));
    expect(names().map((input) => input.value)).toEqual(["X-Trace"]);
    expect(onValue).toHaveBeenLastCalledWith(expect.objectContaining({ headers: [{ name: "X-Trace", value: "" }] }));
  });

  it("hides the editor when showHeaders is false", () => {
    render(<Harness showHeaders={false} />);
    expect(screen.queryByRole("button", { name: "Add header" })).not.toBeInTheDocument();
  });
});

describe("EndpointFields: general", () => {
  it("disables every control when disabled", () => {
    render(
      <Harness
        disabled
        initial={{
          baseUrl: "http://192.168.1.10:8000",
          auth: { mode: "header", header_name: "api-key", prefix: "" },
          headers: [{ name: "X-Org", value: "acme" }],
        }}
        secretStatus={{ saved: true, hint: "ab12" }}
        onSecretChange={() => {}}
      />,
    );
    for (const textbox of screen.getAllByRole("textbox")) expect(textbox).toBeDisabled();
    expect(screen.getByLabelText("API Key")).toBeDisabled();
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });

  it("keeps the ids of several instances apart", () => {
    render(
      <>
        <Harness initial={{ baseUrl: "https://a.example/v1" }} />
        <Harness initial={{ baseUrl: "https://b.example/v1" }} idPrefix="stt" />
      </>,
    );
    const inputs = screen.getAllByLabelText<HTMLInputElement>("Base URL");
    expect(inputs.map((input) => input.value)).toEqual(["https://a.example/v1", "https://b.example/v1"]);
    expect(inputs[1].id).toBe("stt-base-url");
  });

  it("is translated into Chinese", async () => {
    await changeUiLanguage("zh-CN");
    const { container } = render(
      <Harness
        initial={{
          baseUrl: "http://192.168.1.10:8000",
          auth: { mode: "header", header_name: "", prefix: "" },
          headers: [{ name: "X-Org", value: "acme" }],
        }}
        secretStatus={{ saved: false }}
        onSecretChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("接口地址（Base URL）")).toBeInTheDocument();
    expect(screen.getByText("实际请求地址")).toBeInTheDocument();
    expect(screen.getByText("大多数 OpenAI 兼容服务需要 /v1 之类的版本前缀。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "补上 /v1" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "认证方式" })).toBeInTheDocument();
    expect(screen.getByText("请填写请求头名称。")).toBeInTheDocument();
    expect(
      untranslatedWords(container, [
        "Base", "URL", "API", "Key", "Bearer", "Token", "OpenAI", "http", "https", "api", "key", "example",
        "com", "chat", "completions", "Org", "acme",
      ]),
    ).toEqual([]);
  });
});
