#!/usr/bin/env node
// NexQ Plus release: bump the version, add a CHANGELOG.plus.md entry, commit,
// tag `plus-v<version>` and push; the tag builds and publishes the release on
// GitHub (.github/workflows/release-plus.yml).
//
//   npm run release:plus                 next patch version (2.41.3 → 2.41.4)
//   npm run release:plus -- 2.42.0       a version of your choice
//   npm run release:plus -- --dry-run    show the version and notes, change nothing
//   node scripts/release-plus.mjs --notes 2.41.4   print that version's notes (CI)
//
// The entry lists this fork's own feat / fix / perf commits since the last
// `plus-v*` tag (upstream's commits are left out: they are reachable from
// upstream/main) and the upstream versions merged in. Upstream's own
// CHANGELOG.md and its `v*` tags are left alone; the `plus-` prefix keeps the
// two sets of tags apart in one clone.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = join(root, "CHANGELOG.plus.md");
const REPO = "https://github.com/PLus123456/NexQ-Plus";
const BRANCH = "custom";
const TAG_PREFIX = "plus-v";
const UPSTREAM = "upstream/main";

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return "";
  }
};
const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const HEADER = `# NexQ Plus changelog

What changed in each NexQ Plus release. The update dialog reads this file;
\`npm run release:plus\` adds an entry. Upstream NexQ's own history is in
CHANGELOG.md.
`;

/** The changelog section of `version`, without its heading line. */
export function notesFor(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const heading = new RegExp(`^#{1,3}\\s+\\[?${version.replace(/\./g, "\\.")}\\]?[\\s(]`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && /^#{1,2}\s+\[?\d+\.\d+\.\d+/.test(line));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

const SECTIONS = [
  ["feat", "Features"],
  ["fix", "Bug Fixes"],
  ["perf", "Performance Improvements"],
];

/**
 * A changelog entry from commit subjects (conventional commits) and the
 * upstream versions merged in; null when nothing would be listed.
 */
export function buildEntry({ version, previous, date, subjects, upstreamVersions }) {
  const bullets = new Map(SECTIONS.map(([, title]) => [title, []]));
  for (const subject of subjects) {
    const m = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
    if (!m) continue;
    const section = SECTIONS.find(([type]) => type === m[1]);
    if (!section) continue;
    bullets.get(section[1]).push(m[2] ? `* **${m[2]}:** ${m[4]}` : `* ${m[4]}`);
  }
  const blocks = [...bullets].filter(([, items]) => items.length > 0).map(([title, items]) => `### ${title}\n\n${items.join("\n")}`);
  if (upstreamVersions.length > 0) {
    blocks.push(`### Upstream\n\n${upstreamVersions.map((v) => `* Merged upstream NexQ ${v}`).join("\n")}`);
  }
  if (blocks.length === 0) return null;
  const link = previous ? `${REPO}/compare/${TAG_PREFIX}${previous}...${TAG_PREFIX}${version}` : `${REPO}/releases/tag/${TAG_PREFIX}${version}`;
  return `## [${version}](${link}) (${date})\n\n${blocks.join("\n\n")}\n`;
}

const parseVersion = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? m.slice(1).map(Number) : null;
};
const newer = (a, b) => {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--notes") {
    const version = args[1];
    const notes = existsSync(CHANGELOG) ? notesFor(readFileSync(CHANGELOG, "utf8"), version ?? "") : null;
    if (!notes) fail(`CHANGELOG.plus.md has no entry for ${version}`);
    console.log(notes);
    console.log(
      `\n---\n\nmacOS (Apple Silicon): open the .dmg and drag NexQ Plus into Applications. The app is not notarized: if macOS says it can't check it, right-click the app → Open once, or run \`xattr -dr com.apple.quarantine "/Applications/NexQ Plus.app"\`. Installed copies update themselves.`,
    );
    return;
  }

  const dryRun = args.includes("--dry-run");
  const requested = args.find((a) => !a.startsWith("--"));

  if (!dryRun) {
    if (git("rev-parse", "--abbrev-ref", "HEAD") !== BRANCH) fail(`Release from ${BRANCH}.`);
    if (git("status", "--porcelain")) fail("The working tree has uncommitted changes.");
    git("fetch", "origin", BRANCH, "--quiet");
    if (git("rev-list", "--count", `HEAD..origin/${BRANCH}`) !== "0") fail(`origin/${BRANCH} has commits this branch lacks: pull first.`);
  }

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const tags = tryGit("tag", "--list", `${TAG_PREFIX}*`, "--sort=-v:refname").split("\n").filter(Boolean);
  const lastTag = tags[0] ?? "";
  const previous = lastTag ? lastTag.slice(TAG_PREFIX.length) : null;

  const [major, minor, patch] = parseVersion(pkg.version) ?? fail(`package.json has an odd version: ${pkg.version}`);
  const version = requested ?? `${major}.${minor}.${patch + 1}`;
  if (!parseVersion(version)) fail(`Not a version: ${version} (use 1.2.3)`);
  if (previous && !newer(version, previous)) fail(`${version} is not newer than the last release ${previous}.`);
  if (tryGit("rev-parse", "-q", "--verify", `refs/tags/${TAG_PREFIX}${version}`)) fail(`Tag ${TAG_PREFIX}${version} already exists.`);
  if (!tryGit("rev-parse", "-q", "--verify", UPSTREAM)) fail(`${UPSTREAM} is missing: git fetch upstream`);

  const range = lastTag ? [`${lastTag}..HEAD`] : ["HEAD"];
  const subjects = tryGit("log", ...range, "--no-merges", "--format=%s", "--not", UPSTREAM).split("\n").filter(Boolean);
  // Merges whose second parent is upstream's history: the upstream versions synced.
  const upstreamVersions = tryGit("log", ...range, "--merges", "--format=%P")
    .split("\n")
    .filter(Boolean)
    .map((parents) => parents.split(" ")[1])
    .filter((p) => p && isAncestor(p, UPSTREAM))
    .map((p) => tryGit("describe", "--tags", "--abbrev=0", "--match", "v*", p))
    .filter(Boolean)
    .filter((v, i, all) => all.indexOf(v) === i)
    .reverse();

  const date = new Date().toISOString().slice(0, 10);
  const entry = buildEntry({ version, previous, date, subjects, upstreamVersions });
  if (!entry) fail(`No feat / fix / perf commits since ${lastTag || "the start"}: nothing to release.`);

  console.log(`NexQ Plus ${pkg.version} → ${version} (${subjects.length} commit(s) since ${lastTag || "the start"})\n`);
  console.log(entry);
  if (dryRun) {
    console.log("[dry-run] Nothing changed.");
    return;
  }

  const current = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, "utf8") : HEADER;
  const at = current.search(/^#{1,2}\s+\[?\d+\.\d+\.\d+/m);
  const next = at === -1 ? `${current.trimEnd()}\n\n${entry}` : `${current.slice(0, at)}${entry}\n${current.slice(at)}`;
  writeFileSync(CHANGELOG, next);

  pkg.version = version;
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  execFileSync("node", ["scripts/sync-version.js"], { cwd: root, stdio: "inherit" });
  const lockPath = join(root, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  git("add", "CHANGELOG.plus.md", "package.json", "package-lock.json", "src/lib/version.ts", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock");
  git("commit", "-m", `chore(release): NexQ Plus ${version}`);
  git("tag", "-a", `${TAG_PREFIX}${version}`, "-m", `NexQ Plus ${version}`);
  git("push", "origin", BRANCH);
  // Only this tag: a plain `git push --tags` would also push upstream's v* tags.
  git("push", "origin", `refs/tags/${TAG_PREFIX}${version}`);
  console.log(`\n✓ Pushed ${TAG_PREFIX}${version}. The build: ${REPO}/actions/workflows/release-plus.yml`);
}

function isAncestor(commit, of) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, of], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
