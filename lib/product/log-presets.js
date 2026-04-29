// @ts-check
/**
 * Catalog of named log line patterns. Each preset is a regex string with
 * named groups out of `time`, `level`, `msg`. The dashboard compiles the
 * resolved regex once per source and uses it to split each line into the
 * three coloured chunks; the CLI and MCP just pass the preset name
 * through and let the renderer resolve it.
 *
 * Patterns are intentionally tolerant — they should match the common
 * shape of each format and silently fall through to "render raw" on
 * lines that don't fit (e.g. multi-line stack traces, banner lines).
 *
 * Adding a preset: keep it small (3-5 fields max), avoid greedy or
 * nested quantifiers (catastrophic backtracking), prefer character
 * classes over `.` where possible.
 */

/**
 * @typedef {{
 *   name: string,
 *   pattern: string,
 *   description: string,
 * }} LogPreset
 */

/** @type {Record<string, LogPreset>} */
const PRESETS = {
    journalctl: {
        name: 'journalctl',
        // `journalctl --output=short`: "Mon DD HH:MM:SS host unit[pid]: message".
        // No level field in this output mode — unit stays as part of `msg`
        // so it remains visible in the panel.
        pattern: '^(?<time>\\w{3}\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2})\\s+\\S+\\s+(?<msg>.*)$',
        description: 'systemd journal "short" output (no level captured)',
    },
    spdlog: {
        name: 'spdlog',
        // Thinger.io / agent flavour: "YYYY-MM-DD HH:MM:SS.mmm (...) [worker thread N] file.cpp:NN  LEVEL| msg".
        // `LEVEL` is uppercase. The two-space gap before the level and
        // the trailing pipe are diagnostic enough to avoid matching
        // unrelated lines that happen to start with a timestamp.
        pattern:
            '^(?<time>\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3})\\s+\\([^)]*\\)\\s+\\[[^\\]]*\\]\\s+\\S+\\s+(?<level>[A-Z]+)\\|\\s*(?<msg>.*)$',
        description: 'spdlog as emitted by the thinger server / agent (LEVEL| msg)',
    },
    'spdlog-bracket': {
        name: 'spdlog-bracket',
        // Default spdlog pattern: "[YYYY-MM-DD HH:MM:SS.mmm] [logger] [level] msg".
        // The middle bracketed groups are optional so a bare
        // "[time] [level] msg" line still matches.
        pattern:
            '^\\[(?<time>\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d+)\\](?:\\s+\\[[^\\]]+\\])*\\s+\\[(?<level>\\w+)\\]\\s+(?<msg>.*)$',
        description: 'spdlog default bracketed pattern: [time] [logger] [level] msg',
    },
    'nginx-error': {
        name: 'nginx-error',
        // Format: "YYYY/MM/DD HH:MM:SS [level] pid#tid: *cid message".
        pattern:
            '^(?<time>\\d{4}/\\d{2}/\\d{2} \\d{2}:\\d{2}:\\d{2})\\s+\\[(?<level>\\w+)\\]\\s+(?<msg>.*)$',
        description: 'nginx error log: "YYYY/MM/DD HH:MM:SS [level] pid#tid: msg"',
    },
    'nginx-access': {
        name: 'nginx-access',
        // Common Log Format with a few extras. No level field, but the
        // request line + status code carries enough signal that the
        // panel can still split time and msg cleanly.
        pattern:
            '^(?<msg>\\S+\\s+\\S+\\s+\\S+\\s+\\[(?<time>[^\\]]+)\\]\\s+.*)$',
        description: 'nginx access log (CLF): no level captured, time inside brackets',
    },
};

/**
 * Levels captured by patterns are normalized to lowercase before any
 * comparison. This list is the canonical set the renderer recognises;
 * unknown levels still render with the `info` palette but are kept
 * verbatim in the level slot for debugging.
 */
export const LOG_LEVELS = /** @type {const} */ ([
    'trace',
    'debug',
    'info',
    'notice',
    'warn',
    'warning',
    'error',
    'critical',
    'crit',
    'fatal',
]);

/**
 * Lookup table for level → severity. Higher number means more severe.
 * Used by the panel filter to test "is this line at or above the
 * configured threshold?".
 */
export const LEVEL_SEVERITY = /** @type {Record<string, number>} */ ({
    trace: 0,
    debug: 0,
    info: 1,
    notice: 2,
    warn: 3,
    warning: 3,
    error: 4,
    critical: 5,
    crit: 5,
    fatal: 5,
});

/**
 * Return all presets as a sorted list. Used by `thinr product logs presets`
 * and by the MCP `thinr_product_logs_presets` tool.
 *
 * @returns {LogPreset[]}
 */
export function listPresets() {
    return Object.values(PRESETS)
        .map((p) => ({ ...p }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Look up a single preset by name. Returns `null` when the name is not
 * registered so callers can decide whether that's an error or just a
 * "use the literal pattern" path.
 *
 * @param {string} name
 * @returns {LogPreset | null}
 */
export function getPreset(name) {
    if (typeof name !== 'string') return null;
    const p = PRESETS[name];
    return p ? { ...p } : null;
}

/**
 * Set of valid preset names — kept for cheap membership checks in the
 * validator. Returning a fresh array each call would defeat the
 * "validate without allocating" property the schema relies on.
 */
export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS).sort());

/**
 * Parse a single log line against a (compiled or string) pattern.
 * Returns `{ time, level, msg, level_norm }` when the line matches and
 * the pattern uses any of the known named groups, or `null` when the
 * line doesn't match. `level_norm` is the lowercase form of the
 * captured level — convenient for color and severity lookups.
 *
 * Passing a `null` regex is supported and returns `null` so callers
 * can use the helper unconditionally.
 *
 * @param {string} line
 * @param {RegExp | null} regex
 * @returns {{ time?: string, level?: string, msg?: string, level_norm?: string } | null}
 */
export function parseLogLine(line, regex) {
    if (!regex) return null;
    const m = regex.exec(line);
    if (!m || !m.groups) return null;
    const { time, level, msg } = m.groups;
    const out = {};
    if (typeof time === 'string') out.time = time;
    if (typeof level === 'string') {
        out.level = level;
        out.level_norm = level.toLowerCase();
    }
    if (typeof msg === 'string') out.msg = msg;
    return out;
}

/**
 * Resolve a level threshold ("all" | "info" | "warn" | "error") against
 * a parsed level. Lines without a captured level pass through (we do
 * not silently hide what we cannot classify). Unknown levels are
 * treated as `info` so debug noise doesn't leak through a `warn+`
 * filter.
 *
 * @param {string | null | undefined} levelNorm
 * @param {'all' | 'info' | 'warn' | 'error'} threshold
 * @returns {boolean}
 */
export function levelPassesThreshold(levelNorm, threshold) {
    if (threshold === 'all') return true;
    if (!levelNorm) return true;
    const sev = LEVEL_SEVERITY[levelNorm];
    const min = LEVEL_SEVERITY[threshold];
    if (sev == null) return min <= LEVEL_SEVERITY.info;
    return sev >= min;
}
