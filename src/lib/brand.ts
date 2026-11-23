// Identity of this build (the NexQ Plus fork). Everything that names the
// product, links to its repository or decides whether it updates itself reads
// from here, so the self-built app never points at the official NexQ.

/** Product name shown in the UI (also injected into translations as {{appName}}). */
export const APP_NAME = "NexQ Plus";

/** This fork's repository: issues, changelog and (one day) its own releases. */
export const REPO_URL = "https://github.com/PLus123456/NexQ-Plus";

/** The upstream project this fork is based on (MIT), credited on the About page. */
export const UPSTREAM_URL = "https://github.com/naxhq/NexQ";

/** Releases page of this fork. */
export const RELEASES_URL = `${REPO_URL}/releases`;

/**
 * Background update checks against this fork's releases (the `plus-v*` tags
 * built by .github/workflows/release-plus.yml). They are signed with the
 * fork's own updater key, whose public half is in tauri.conf.json, so
 * upstream's builds can never replace this app.
 */
export const UPDATER_ENABLED = true;
