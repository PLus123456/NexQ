#!/usr/bin/env node
// Takes a screenshot of the running preview harness (`npm run harness`) with
// headless Google Chrome.
//
//   node harness/shot.mjs "<query string>" <out.png> [width] [height]
//   node harness/shot.mjs "scene=streaming&w=420&h=560" /tmp/streaming.png
//
// The browser window is as big as the frame the query asks for (`w`, `h`, or
// the view's default), so the picture is the app's window and nothing else;
// the captions view gets some room below it for the list of scripted events.
// Chrome runs the page for 8 seconds of virtual time before the picture. What
// the page wrote to its console is printed afterwards: look there for errors.
//
// CHROME_PATH and HARNESS_URL override the browser and the address.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ORIGIN = process.env.HARNESS_URL ?? "http://localhost:5199";
/** Room below the caption strip for the harness's list of the events it sent. */
const CAPTION_EVENTS_HEIGHT = 130;

const [queryArg, outArg, widthArg, heightArg] = process.argv.slice(2);
if (queryArg === undefined || !outArg) {
  console.error('usage: node harness/shot.mjs "<query string>" <out.png> [width] [height]');
  process.exit(2);
}
if (!existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME} (set CHROME_PATH)`);
  process.exit(1);
}

const query = queryArg.replace(/^\?/, "");
const params = new URLSearchParams(query);
const captions = params.get("view") === "captions";
const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : null);
const width = positive(widthArg) ?? positive(params.get("w")) ?? (captions ? 900 : 500);
const height = positive(heightArg)
  ?? (positive(params.get("h")) ?? (captions ? 140 : 700)) + (captions ? CAPTION_EVENTS_HEIGHT : 0);

const out = path.resolve(outArg);
mkdirSync(path.dirname(out), { recursive: true });
rmSync(out, { force: true });
const profile = mkdtempSync(path.join(tmpdir(), "nexq-harness-chrome-"));
const url = `${ORIGIN}/${query ? `?${query}` : ""}`;

const chrome = spawnSync(
  CHROME,
  [
    "--headless=new",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--virtual-time-budget=8000",
    "--enable-logging=stderr",
    "--v=0",
    `--screenshot=${out}`,
    url,
  ],
  { encoding: "utf8", timeout: 90_000 },
);
rmSync(profile, { recursive: true, force: true });

// The page's console, as Chrome logs it: [pid:tid:date:INFO:CONSOLE:line] "message", source: file (line)
const consoleLines = (chrome.stderr ?? "")
  .split("\n")
  .filter((line) => /:CONSOLE[:(]/.test(line))
  .map((line) => line.replace(/^\[[^\]]*?:(\w+):CONSOLE[:(]\d+\)?\]\s*/, "$1 "));

if (!existsSync(out)) {
  console.error(`No screenshot was written. Is the harness running (${ORIGIN})? Start it with: npm run harness`);
  if (chrome.error) console.error(String(chrome.error));
  process.exit(1);
}
console.log(`${out}  (${width}×${height} at 2x)  ${url}`);
if (consoleLines.length > 0) console.log(`page console:\n  ${consoleLines.join("\n  ")}`);
