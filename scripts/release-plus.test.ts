import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEntry, notesFor } from "./release-plus.mjs";
import { parseChangelog } from "../src/lib/releaseNotes.mjs";

const base = { version: "2.41.4", previous: "2.41.3", date: "2026-11-23", upstreamVersions: [] as string[] };

describe("buildEntry", () => {
  it("lists feat, fix and perf commits by section and leaves out the rest", () => {
    const entry = buildEntry({
      ...base,
      subjects: [
        "fix(captions): judge the mouse right on screens scaled unlike the main one",
        "feat: a release workflow",
        "chore(fork): rename the repository",
        "docs: explain the release",
        "perf(rag): faster search",
      ],
    })!;
    expect(entry).toContain("## [2.41.4](https://github.com/PLus123456/NexQ-Plus/compare/plus-v2.41.3...plus-v2.41.4) (2026-11-23)");
    expect(entry).toContain("### Features\n\n* a release workflow");
    expect(entry).toContain("### Bug Fixes\n\n* **captions:** judge the mouse right on screens scaled unlike the main one");
    expect(entry).toContain("### Performance Improvements\n\n* **rag:** faster search");
    expect(entry).not.toContain("rename the repository");
    expect(entry).not.toContain("explain the release");
  });

  it("names the upstream versions merged in", () => {
    const entry = buildEntry({ ...base, subjects: [], upstreamVersions: ["v2.44.0"] })!;
    expect(entry).toContain("### Upstream\n\n* Merged upstream NexQ v2.44.0");
  });

  it("gives nothing when there is nothing to tell", () => {
    expect(buildEntry({ ...base, subjects: ["chore: tidy"] })).toBeNull();
  });

  it("reads back through the update dialog's parser", () => {
    const entry = buildEntry({ ...base, subjects: ["feat(captions): centered captions", "fix: a bug"] })!;
    const [release] = parseChangelog(entry);
    expect(release.version).toBe("2.41.4");
    expect(release.date).toBe("2026-11-23");
    expect(release.sections.map((s) => s.title)).toEqual(["New", "Fixed"]);
    expect(release.sections[0].items).toEqual(["Centered captions"]);
  });
});

describe("notesFor", () => {
  const markdown = `# NexQ Plus changelog\n\nIntro.\n\n## [2.41.5](x) (2026-11-25)\n\n### Bug Fixes\n\n* five\n\n## [2.41.4](x) (2026-11-24)\n\n### Features\n\n* four\n`;

  it("takes one release's section, without its heading", () => {
    expect(notesFor(markdown, "2.41.4")).toBe("### Features\n\n* four");
    expect(notesFor(markdown, "2.41.5")).toBe("### Bug Fixes\n\n* five");
  });

  it("does not take 2.41.40 for 2.41.4, and gives null for a missing version", () => {
    expect(notesFor("## [2.41.40](x) (2026-11-24)\n\n* forty\n", "2.41.4")).toBeNull();
    expect(notesFor(markdown, "9.9.9")).toBeNull();
  });

  it("finds the first release in the real changelog", () => {
    const real = readFileSync(join(__dirname, "..", "CHANGELOG.plus.md"), "utf8");
    expect(notesFor(real, "2.41.3")).toContain("### Features");
    expect(parseChangelog(real)[0].version).toBe("2.41.3");
  });
});
