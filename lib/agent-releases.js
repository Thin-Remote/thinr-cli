// @ts-check

/**
 * Small helper that talks to the public release CDN at
 * `https://get.thinremote.io/<channel>.json`. Same file the agent itself
 * polls to decide whether a self-update is available — keeping a single
 * source of truth between what the CLI offers and what a device would
 * actually download if the user ran `thinr device update apply`.
 *
 * Why a dedicated module: the TUI hook (`useLatestAgentVersion`) needed
 * React-aware polling, the CLI just wants a one-shot fetch. Sharing the
 * URL and the response shape here avoids drift if we ever add fields
 * (signing keys, min-supported-version, etc.) to the JSON.
 */

const CDN_BASE = 'https://get.thinremote.io';
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Fetch the release descriptor for a channel.
 * @param {object} [opts]
 * @param {string} [opts.channel='latest']  Release channel — matches the
 *   filenames under get.thinremote.io (`latest.json`, `main.json`,
 *   `develop.json`). Per-version archives are not exposed here; devices
 *   resolve those through the channel metadata themselves.
 * @param {number} [opts.timeoutMs]  Hard cap on the network call. 5s is
 *   plenty for a 1 KB JSON off a global CDN; anything slower is a DNS or
 *   connectivity issue that should fail fast rather than stall the CLI.
 * @returns {Promise<{version: string, checksums?: Record<string,string>}>}
 */
export async function fetchReleaseDescriptor({
    channel = 'latest',
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    const url = `${CDN_BASE}/${encodeURIComponent(channel)}.json`;
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
            throw new Error(
                `release descriptor fetch failed: ${res.status} ${res.statusText}`,
            );
        }
        const data = await res.json();
        if (!data?.version) {
            throw new Error('release descriptor missing `version` field');
        }
        return data;
    } finally {
        clearTimeout(to);
    }
}

/** Convenience: just the version string. */
export async function fetchLatestAgentVersion(opts) {
    const { version } = await fetchReleaseDescriptor(opts);
    return version;
}
