#!/usr/bin/env node
// i18n-check (NexQ Plus): validates the UI translation files and, with
// --report, lists English text that looks hard-coded in source files.
//
//   node scripts/i18n-check.mjs                     key check (exit 1 on errors)
//   node scripts/i18n-check.mjs --report <path...>  key check + hard-coded text report
//   node scripts/i18n-check.mjs --report src --fail-on-report   also exit 1 if the report isn't empty
//
// Key check, for every namespace listed in src/i18n/resources.ts:
// - src/i18n/locales/{en,zh-CN}/<namespace>.json exist, are valid JSON objects
//   without duplicate keys, and hold only strings and nested objects;
// - both languages have the same keys. Plurals are compared by base key: en
//   uses `_one` / `_other`, zh-CN only needs `_other`;
// - each key uses the same {{placeholders}} in both languages.
//
// The report is a heuristic for self-review (JSX text, title / aria-label /
// placeholder / alt attributes, label-like object fields, toasts). Lines with
// `i18n-ignore` are skipped.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const I18N_DIR = join(ROOT, "src", "i18n");
const LOCALES_DIR = join(I18N_DIR, "locales");
const LANGUAGES = ["en", "zh-CN"];
const SOURCE_LANGUAGE = "en";
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

const errors = [];
const warnings = [];

// ── JSON with duplicate-key detection ───────────────────────────────────────

/** Parses JSON like JSON.parse but reports duplicate keys (JSON.parse keeps the last one). */
function parseJsonStrict(text, file) {
  let i = 0;
  const fail = (msg) => {
    const line = text.slice(0, i).split("\n").length;
    throw new Error(`${file}:${line}: ${msg}`);
  };
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const string = () => {
    const start = i;
    i++; // opening quote
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    if (i >= text.length) fail("unterminated string");
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const value = (path) => {
    ws();
    const c = text[i];
    if (c === "{") return object(path);
    if (c === "[") {
      i++;
      const arr = [];
      ws();
      if (text[i] === "]") return i++, arr;
      for (;;) {
        arr.push(value(`${path}[${arr.length}]`));
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return arr; }
        fail("expected , or ]");
      }
    }
    if (c === '"') return string();
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) fail(`unexpected ${JSON.stringify(c ?? "end of file")}`);
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const object = (path) => {
    i++;
    const obj = {};
    const seen = new Set();
    ws();
    if (text[i] === "}") return i++, obj;
    for (;;) {
      ws();
      if (text[i] !== '"') fail("expected a key");
      const key = string();
      const keyPath = path ? `${path}.${key}` : key;
      if (seen.has(key)) errors.push(`${file}: duplicate key "${keyPath}"`);
      seen.add(key);
      ws();
      if (text[i] !== ":") fail("expected :");
      i++;
      obj[key] = value(keyPath);
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return obj; }
      fail("expected , or }");
    }
  };
  const result = value("");
  ws();
  if (i < text.length) fail("trailing content");
  return result;
}

// ── Key check ───────────────────────────────────────────────────────────────

/** Namespaces declared in resources.ts (`NAMESPACES = [ ... ] as const`). */
function declaredNamespaces() {
  const source = readFileSync(join(I18N_DIR, "resources.ts"), "utf8");
  const m = /export const NAMESPACES\s*=\s*\[([^\]]*)\]/.exec(source);
  if (!m) {
    errors.push("src/i18n/resources.ts: NAMESPACES not found");
    return [];
  }
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Flattens to { "a.b.c": "text" }, reporting non-string leaves. */
function flatten(obj, file, prefix = "", out = {}) {
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) flatten(val, file, path, out);
    else if (typeof val === "string") out[path] = val;
    else errors.push(`${file}: "${path}" must be a string or an object, got ${JSON.stringify(val)}`);
  }
  return out;
}

function placeholders(text) {
  return [...text.matchAll(/\{\{\s*([^}\s,]+)[^}]*\}\}/g)].map((m) => m[1]).sort();
}

function loadLocale(lang, ns) {
  const file = join(LOCALES_DIR, lang, `${ns}.json`);
  const rel = relative(ROOT, file);
  if (!existsSync(file)) {
    errors.push(`${rel}: missing (every namespace needs a file in every language)`);
    return null;
  }
  try {
    const parsed = parseJsonStrict(readFileSync(file, "utf8"), rel);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push(`${rel}: top level must be an object`);
      return null;
    }
    return flatten(parsed, rel);
  } catch (err) {
    errors.push(`${rel}: invalid JSON (${err.message})`);
    return null;
  }
}

function checkNamespace(ns) {
  const source = loadLocale(SOURCE_LANGUAGE, ns);
  const counts = { [SOURCE_LANGUAGE]: source ? Object.keys(source).length : 0 };
  for (const lang of LANGUAGES.filter((l) => l !== SOURCE_LANGUAGE)) {
    const target = loadLocale(lang, ns);
    counts[lang] = target ? Object.keys(target).length : 0;
    if (!source || !target) continue;
    const file = `src/i18n/locales/${lang}/${ns}.json`;

    const base = (key) => key.replace(PLURAL_SUFFIX, "");
    const sourceBases = new Set(Object.keys(source).map(base));
    const targetBases = new Set(Object.keys(target).map(base));
    for (const key of sourceBases) {
      if (!targetBases.has(key)) errors.push(`${file}: missing key "${key}" (present in ${SOURCE_LANGUAGE})`);
    }
    for (const key of targetBases) {
      if (!sourceBases.has(key)) errors.push(`${file}: extra key "${key}" (not in ${SOURCE_LANGUAGE})`);
    }
    for (const key of Object.keys(source)) {
      if (PLURAL_SUFFIX.test(key)) {
        const other = `${base(key)}_other`;
        if (targetBases.has(base(key)) && !(other in target)) {
          errors.push(`${file}: plural "${base(key)}" needs "${other}"`);
        }
      } else if (Object.keys(target).some((k) => PLURAL_SUFFIX.test(k) && base(k) === key)) {
        errors.push(`${file}: "${key}" is plural here but not in ${SOURCE_LANGUAGE}`);
      }
    }

    // Placeholders: compare each target key with the source key of the same base.
    for (const [key, text] of Object.entries(target)) {
      const sourceKey = key in source ? key : Object.keys(source).find((k) => base(k) === base(key) && k.endsWith("_other"));
      if (!sourceKey) continue;
      const want = placeholders(source[sourceKey]).filter((p) => p !== "count");
      const got = placeholders(text).filter((p) => p !== "count");
      if (want.join() !== got.join()) {
        errors.push(`${file}: "${key}" uses {{${got.join("}}, {{")}}} but ${SOURCE_LANGUAGE} uses {{${want.join("}}, {{")}}}`);
      }
      if (/\bNexQ\b/.test(text)) warnings.push(`${file}: "${key}" names the product; use {{appName}}`);
    }
  }
  return counts;
}

function checkKeys() {
  const namespaces = declaredNamespaces();
  for (const lang of LANGUAGES) {
    const dir = join(LOCALES_DIR, lang);
    if (!existsSync(dir)) {
      errors.push(`src/i18n/locales/${lang}: missing`);
      continue;
    }
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const ns = basename(file, ".json");
      if (!namespaces.includes(ns)) errors.push(`src/i18n/locales/${lang}/${file}: namespace "${ns}" is not in NAMESPACES (src/i18n/resources.ts)`);
    }
  }
  const rows = namespaces.map((ns) => [ns, checkNamespace(ns)]);
  console.log(`i18n-check: ${namespaces.length} namespaces × ${LANGUAGES.length} languages (${LANGUAGES.join(", ")})`);
  for (const [ns, counts] of rows) {
    const cells = LANGUAGES.map((lang) => `${lang} ${String(counts[lang]).padStart(4)}`).join("  ");
    console.log(`  ${ns.padEnd(12)} ${cells}`);
  }
}

// ── Hard-coded text report ──────────────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIPPED_DIRS = new Set(["node_modules", "i18n", "demo", "test", "__tests__"]);

function sourceFiles(path, out = []) {
  const abs = resolve(ROOT, path);
  if (!existsSync(abs)) {
    errors.push(`--report: ${path} not found`);
    return out;
  }
  if (statSync(abs).isDirectory()) {
    for (const entry of readdirSync(abs)) {
      if (SKIPPED_DIRS.has(entry)) continue;
      sourceFiles(join(abs, entry), out);
    }
  } else if (
    SOURCE_EXTENSIONS.has(extname(abs)) &&
    !/\.(test|spec)\.tsx?$/.test(abs) &&
    !abs.endsWith(".d.ts")
  ) {
    out.push(abs);
  }
  return out;
}

/** Text a person would read: has a word, isn't an identifier, key, URL, path or class list. */
function looksLikeUiText(text) {
  const s = text.trim();
  if (!/[A-Za-z]{2,}/.test(s)) return false;
  if (/^(https?:|mailto:|\/|\.\/|#|@)/.test(s)) return false;
  if (/^[\w.-]+:[\w.$-]+/.test(s) && !s.includes(" ")) return false; // ns:key, 'llm_stream_token', 'CmdOrCtrl+K'
  if (!s.includes(" ")) {
    // One token: report only capitalized words ("Save"), not identifiers.
    if (!/^[A-Z][a-z]+(-[A-Za-z][a-z]+)*[.!?…:]?$/.test(s)) return false;
  }
  if (/^[a-z0-9:/[\]().%!#&-]+( [a-z0-9:/[\]().%!#&-]+)*$/.test(s) && /-/.test(s)) return false; // tailwind classes
  if (/[{}=;|]|=>|\$\{/.test(s)) return false; // code
  if (TYPE_NAMES.has(s)) return false; // generics read as "> Promise <"
  return true;
}

const TYPE_NAMES = new Set(["Promise", "Record", "Partial", "Array", "Map", "Set", "Readonly", "Pick", "Omit", "Exclude"]);

const PATTERNS = [
  ["attribute", /\b(title|aria-label|placeholder|alt|label|tooltip|description)=["']([^"'{}]+)["']/g, 2],
  ["field", /\b(label|title|description|placeholder|hint|message|tooltip|detail|okLabel|cancelLabel)\s*:\s*["']([^"']+)["']/g, 2],
  ["toast", /\bshowToast\(\s*["'`]([^"'`]+)["'`]/g, 1],
  ["jsx text", />\s*([^<>{}]*[A-Za-z]{2,}[^<>{}]*?)\s*</g, 1],
  // Text that starts a line and runs into a tag: "Moved to the <strong>…".
  ["jsx text", /^\s*([A-Z][^<>{}=;"'`]*[A-Za-z]{2,}[^<>{}=;"'`]*?)\s*</g, 1],
];

function reportFile(file) {
  const isJsx = file.endsWith(".tsx");
  const findings = [];
  const lines = readFileSync(file, "utf8").split("\n");
  let inBlockComment = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      return;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      return;
    }
    if (
      trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("import ") ||
      line.includes("i18n-ignore") || /console\.(log|warn|error|info|debug)\(/.test(line)
    ) {
      return;
    }
    const code = line.replace(/\s\/\/\s.*$/, "");
    const seen = new Set();
    for (const [kind, re, group] of PATTERNS) {
      if (kind === "jsx text" && !isJsx) continue;
      for (const m of code.matchAll(re)) {
        const text = m[group].trim();
        if (seen.has(text) || !looksLikeUiText(text)) continue;
        seen.add(text);
        findings.push({ line: index + 1, kind, text });
      }
    }
    // JSX text on its own line (between tags spread over several lines).
    if (
      isJsx &&
      /^[A-Z][\w'’-]*(( [\w'’.,!?:;&()/%+…—–-]+)+[.!?…:]?|[.!?…:]?)$/.test(trimmed) &&
      !/^(export|return|const|let|type|interface|case|default|throw|await|import)\b/.test(trimmed) &&
      !seen.has(trimmed) && looksLikeUiText(trimmed)
    ) {
      findings.push({ line: index + 1, kind: "jsx text", text: trimmed });
    }
  });
  return findings;
}

function report(paths) {
  const files = paths.flatMap((p) => sourceFiles(p)).sort();
  let total = 0;
  const perFile = [];
  for (const file of files) {
    const findings = reportFile(file);
    if (!findings.length) continue;
    total += findings.length;
    perFile.push([relative(ROOT, file), findings]);
  }
  console.log(`\nHard-coded text report: ${total} finding(s) in ${perFile.length} of ${files.length} file(s)`);
  for (const [file, findings] of perFile) {
    console.log(`\n${file} (${findings.length})`);
    for (const f of findings) console.log(`  ${String(f.line).padStart(5)}  ${f.kind.padEnd(9)}  ${JSON.stringify(f.text)}`);
  }
  return total;
}

// ── Main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const reportIndex = args.indexOf("--report");
const failOnReport = args.includes("--fail-on-report");
const reportPaths = reportIndex === -1 ? [] : args.slice(reportIndex + 1).filter((a) => !a.startsWith("--"));
if (reportIndex !== -1 && reportPaths.length === 0) {
  console.error("usage: node scripts/i18n-check.mjs [--report <file or dir>...] [--fail-on-report]");
  process.exit(2);
}

checkKeys();
const findings = reportPaths.length ? report(reportPaths) : 0;

for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
if (failOnReport && findings > 0) process.exit(1);
console.log(errors.length || warnings.length ? "" : "\nOK: keys match in every namespace.");
