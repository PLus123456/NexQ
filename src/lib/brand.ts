// Identity of this build (the NexQ Plus fork). Everything that names the
// product, links to its repository or decides whether it updates itself reads
// from here, so the self-built app never points at the official NexQ.

/** Product name shown in the UI (also injected into translations as {{appName}}). */
export const APP_NAME = "NexQ Plus";

/** This fork's repository: issues, changelog and (one day) its own releases. */
export const REPO_URL = "https://github.com/PLus123456/NexQ";

/** The upstream project this fork is based on (MIT), credited on the About page. */
export const UPSTREAM_URL = "https://github.com/naxhq/NexQ";

/** Releases page of this fork. */
export const RELEASES_URL = `${REPO_URL}/releases`;

/**
 * Background update checks. Off in the first fork release: the updater would
 * otherwise fetch upstream's signed builds and replace this app on quit.
 * Turn on only once the fork publishes its own signed releases.
 */
export const UPDATER_ENABLED = false;
