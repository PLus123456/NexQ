#!/usr/bin/env node
// Automated DOM layout verification for the redesigned answer window against the
// running preview harness (`npm run harness -- --port 5211`).
//
// Usage:
//   HARNESS_URL=http://localhost:5211 node harness/check-answer-layout.mjs [--shots-dir /tmp/answer-shots]
//
// Checks:
// 1. 420×560 streaming with 3-line question:
//    - Question panel height <= 72px
//    - AI response panel height >= 60% of 560px (>= 336px)
//    - Pure scrollable answer viewport height reported & checked
//    - Expanding the full-question popover does NOT push the answer card down
// 2. 400×480 minimum size (zh-CN & en):
//    - Zero horizontal overflow (scrollWidth <= clientWidth)
//    - All header controls stay inside the header without clipping or overlap
//    - Single-row thin status bar
// 3. 420×560 transcript scene:
//    - Transcript drawer starts open
// 4. 800×600 transcript scene:
//    - Docking side-by-side switches drawer into side panel beside answer card

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ORIGIN = process.env.HARNESS_URL ?? "http://localhost:5211";

const shotsIdx = process.argv.indexOf("--shots-dir");
const shotsDir = shotsIdx !== -1 ? path.resolve(process.argv[shotsIdx + 1]) : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

if (!existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME} (set CHROME_PATH)`);
  process.exit(1);
}

function assert(cond, message) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function launchChrome() {
  const profile = mkdtempSync(path.join(tmpdir(), "nexq-layout-check-"));
  const port = 9300 + Math.floor(Math.random() * 400);
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // Wait for CDP endpoint to come up.
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) {
        wsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {
      // keep waiting
    }
    await sleep(100);
  }
  if (!wsUrl) {
    proc.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
    throw new Error("Timed out waiting for Chrome DevTools endpoint");
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evalJs = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error(`Page eval error: ${res.exceptionDetails.text}`);
    }
    return res.result?.value;
  };

  const openScene = async (query, w, h, waitMs = 1200) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await send("Page.navigate", { url: `${ORIGIN}/?${query}&w=${w}&h=${h}` });
    // Wait until OverlayView mounts and renders.
    for (let i = 0; i < 60; i++) {
      const ready = await evalJs(`Boolean(document.querySelector('[data-testid="overlay-root"]'))`);
      if (ready) break;
      await sleep(100);
    }
    await sleep(waitMs);
  };

  const capture = async (filename) => {
    if (!shotsDir) return;
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    const out = path.join(shotsDir, filename);
    writeFileSync(out, Buffer.from(data, "base64"));
    console.log(`  saved ${out}`);
  };

  const close = () => {
    try { ws.close(); } catch { /* ignore */ }
    proc.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  };

  await send("Page.enable");
  await send("Runtime.enable");
  return { send, evalJs, openScene, capture, close };
}

const chrome = await launchChrome();
try {
  // ── 1. Acceptance 420×560 streaming with 3-line question ────────────────
  console.log("1. Checking 420×560 streaming layout (zh-CN)...");
  await chrome.openScene("scene=streaming&lang=zh-CN", 420, 560, 1800);
  await chrome.capture("streaming-420x560.png");

  const metrics420 = await chrome.evalJs(`(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    };
    const root = rect('[data-testid="overlay-root"]');
    const header = rect('[data-testid="overlay-header"]');
    const qPanel = rect('[data-testid="question-panel"]');
    const answerCard = rect('[data-testid="answer-card"]');
    const aiPanel = rect('[data-testid="ai-response-panel"]');
    const viewport = rect('[data-testid="answer-viewport"]');
    const progress = rect('[data-testid="response-progress"]');
    const footerBar = rect('[data-testid="answer-footer-bar"]');
    const statusBar = rect('[data-testid="overlay-status-bar"]');
    const modeRow = rect('[data-testid="mode-buttons-row"]');
    return { root, header, qPanel, answerCard, aiPanel, viewport, progress, footerBar, statusBar, modeRow };
  })()`);

  console.log("  420×560 metrics:", JSON.stringify({
    headerH: metrics420.header.height,
    questionPanelH: metrics420.qPanel.height,
    answerCardH: metrics420.answerCard.height,
    aiResponsePanelH: metrics420.aiPanel.height,
    aiResponsePct: +(metrics420.aiPanel.height / 560 * 100).toFixed(1),
    answerViewportH: metrics420.viewport.height,
    answerViewportPct: +(metrics420.viewport.height / 560 * 100).toFixed(1),
    progressH: metrics420.progress?.height,
    answerFooterH: metrics420.footerBar.height,
    statusBarH: metrics420.statusBar.height,
    modeRowH: metrics420.modeRow.height,
    rootScrollW: metrics420.root.scrollWidth,
    rootClientW: metrics420.root.clientWidth,
  }));

  assert(metrics420.qPanel.height <= 72, `Question panel height ${metrics420.qPanel.height}px exceeds 72px`);
  assert(metrics420.aiPanel.height >= 560 * 0.6, `AI response panel height ${metrics420.aiPanel.height}px < 336px (60%)`);
  assert(metrics420.viewport.height >= 560 * 0.6, `Pure answer viewport height ${metrics420.viewport.height}px < 336px (60%)`);
  assert(metrics420.header.height <= 36, `Header height ${metrics420.header.height}px > 36px`);
  assert(metrics420.statusBar.height <= 36, `Status bar height ${metrics420.statusBar.height}px > 36px`);
  assert(metrics420.root.scrollWidth <= metrics420.root.clientWidth, `Horizontal overflow at 420×560: ${metrics420.root.scrollWidth} > ${metrics420.root.clientWidth}`);

  // Clicking question text opens full-text popover WITHOUT shifting answer card.
  const beforeTop = metrics420.answerCard.top;
  await chrome.evalJs(`document.querySelector('[data-testid="question-panel"] button[aria-haspopup="dialog"]')?.click()`);
  await sleep(250);
  await chrome.capture("question-popover-420x560.png");
  const afterPop = await chrome.evalJs(`({
    dialogVisible: Boolean(document.querySelector('[role="dialog"][aria-label="完整问题"]')),
    answerTop: document.querySelector('[data-testid="answer-card"]')?.getBoundingClientRect().top,
  })`);
  assert(afterPop.dialogVisible, "Full-question popover did not open on click");
  assert(Math.abs(afterPop.answerTop - beforeTop) < 0.5, `Full-question popover shifted answer card (${beforeTop} -> ${afterPop.answerTop})`);
  await chrome.evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(150);

  // Open Typeset popover and capture screenshot.
  await chrome.evalJs(`document.querySelector('[data-testid="answer-footer-bar"] button[aria-haspopup="dialog"]')?.click()`);
  await sleep(250);
  await chrome.capture("typeset-popover-420x560.png");
  const typesetOpen = await chrome.evalJs(`Boolean(document.querySelector('[role="dialog"][aria-label="回答排版"]'))`);
  assert(typesetOpen, "Typeset popover did not open");
  await chrome.evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(150);

  // Open "More" menu and capture screenshot.
  await chrome.evalJs(`document.querySelector('[data-testid="overlay-header"] button[aria-haspopup="menu"]')?.click()`);
  await sleep(250);
  await chrome.capture("more-menu-420x560.png");
  const moreMenuCheck = await chrome.evalJs(`(() => {
    const m = document.querySelector('[role="menu"]');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  })()`);
  assert(moreMenuCheck && moreMenuCheck.left >= 0 && moreMenuCheck.right <= 420 && moreMenuCheck.bottom <= 560, `More menu clipped: ${JSON.stringify(moreMenuCheck)}`);

  // ── 2. Minimum size 400×480 checks (zh-CN and en) ───────────────────────
  for (const lang of ["zh-CN", "en"]) {
    console.log(`2. Checking 400×480 minimum size (${lang})...`);
    await chrome.openScene(`scene=streaming&lang=${lang}`, 400, 480, 1200);
    if (lang === "zh-CN") await chrome.capture("streaming-400x480.png");

    const minCheck = await chrome.evalJs(`(() => {
      const root = document.querySelector('[data-testid="overlay-root"]');
      const header = document.querySelector('[data-testid="overlay-header"]');
      const status = document.querySelector('[data-testid="overlay-status-bar"]');
      const hRect = header.getBoundingClientRect();
      const btns = [...header.querySelectorAll('button')].map((b) => {
        const r = b.getBoundingClientRect();
        return { label: b.getAttribute('aria-label'), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
      let overlap = false;
      for (let i = 1; i < btns.length; i++) {
        if (btns[i].left < btns[i - 1].right - 0.5) overlap = true;
      }
      const clipped = btns.some((b) => b.right > hRect.right + 0.5 || b.bottom > hRect.bottom + 0.5);
      return {
        docScrollW: document.documentElement.scrollWidth,
        docClientW: document.documentElement.clientWidth,
        rootScrollW: root.scrollWidth,
        rootClientW: root.clientWidth,
        headerH: hRect.height,
        statusH: status.getBoundingClientRect().height,
        statusScrollW: status.scrollWidth,
        statusClientW: status.clientWidth,
        overlap,
        clipped,
        buttonCount: btns.length,
      };
    })()`);
    console.log(`  400×480 (${lang}) metrics:`, JSON.stringify(minCheck));
    assert(minCheck.rootScrollW <= minCheck.rootClientW, `Root overflow at 400×480 (${lang})`);
    assert(!minCheck.overlap, `Header button overlap at 400×480 (${lang})`);
    assert(!minCheck.clipped, `Header button clipped at 400×480 (${lang})`);
    assert(minCheck.headerH <= 36, `Header wrapped at 400×480 (${lang}): ${minCheck.headerH}px`);
    assert(minCheck.statusH <= 36, `Status bar wrapped at 400×480 (${lang}): ${minCheck.statusH}px`);
  }

  // ── 3. Transcript drawer scene (420×560) ────────────────────────────────
  console.log("3. Checking 420×560 transcript scene (drawer starts open)...");
  await chrome.openScene("scene=transcript&lang=zh-CN", 420, 560, 800);
  await chrome.capture("transcript-420x560.png");
  const drawerVisible = await chrome.evalJs(`Boolean(document.querySelector('[data-testid="transcript-drawer"]'))`);
  assert(drawerVisible, "Transcript drawer did not start open on scene=transcript");

  // ── 4. Wide window 800×600 side-by-side docking ─────────────────────────
  console.log("4. Checking 800×600 transcript side-by-side docking...");
  await chrome.openScene("scene=transcript&lang=zh-CN", 800, 600, 600);
  await chrome.evalJs(`document.querySelector('[data-testid="transcript-drawer"] button[aria-label="并排显示"]')?.click()`);
  await sleep(250);
  await chrome.capture("transcript-docked-800x600.png");
  const sideBySide = await chrome.evalJs(`(() => {
    const side = document.querySelector('[data-testid="transcript-side-panel"]');
    const ans = document.querySelector('[data-testid="answer-card"]');
    if (!side || !ans) return null;
    const sr = side.getBoundingClientRect();
    const ar = ans.getBoundingClientRect();
    return { sideW: sr.width, ansW: ar.width, noOverlap: sr.right <= ar.left + 1 };
  })()`);
  console.log("  800×600 side-by-side metrics:", JSON.stringify(sideBySide));
  assert(sideBySide && sideBySide.noOverlap && sideBySide.ansW >= 320, `Side-by-side layout invalid: ${JSON.stringify(sideBySide)}`);

  console.log("\nALL LAYOUT CHECKS PASSED.");
} finally {
  chrome.close();
}
