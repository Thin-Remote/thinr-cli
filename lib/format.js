// @ts-check
import chalk from 'chalk';

/**
 * Format a duration in seconds as a human-readable string: `309d16h`,
 * `42d15h`, `17m`, `42s`, etc. Returns `—` for invalid/missing values.
 *
 * @param {number | null | undefined} seconds
 * @returns {string}
 */
export function formatUptime(seconds) {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d${h}h`;
    if (h > 0) return `${h}h${m}m`;
    if (m > 0) return `${m}m`;
    return `${Math.floor(seconds)}s`;
}

/**
 * Format seconds elapsed as a "time ago" label: `5s ago`, `3m ago`,
 * `2h ago`, `4d ago`. Returns `—` for invalid/missing values.
 *
 * @param {number | null | undefined} seconds
 * @returns {string}
 */
export function formatAgo(seconds) {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return `${Math.floor(seconds)}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Render a percentage value coloured by threshold: green below 70 %,
 * yellow below 90 %, red at or above 90 %. Returns a dim `—` when the
 * value is missing. Formatted with no decimal places so columns in
 * cli-table3 stay aligned.
 *
 * @param {number | null | undefined} v
 * @returns {string}
 */
export function colorPct(v) {
    if (v == null || !Number.isFinite(v)) return chalk.dim('—');
    const s = `${v.toFixed(0)}%`;
    if (v >= 90) return chalk.red(s);
    if (v >= 70) return chalk.yellow(s);
    return chalk.green(s);
}

/**
 * Format a byte count as a human-readable string picking the largest
 * unit where the value is ≥ 1. `2 bytes`, `12.3 KB`, `145 MB`,
 * `2.4 GB`. Returns `—` for invalid/missing values.
 *
 * @param {number | null | undefined} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(gb >= 100 ? 0 : 2)} GB`;
}
