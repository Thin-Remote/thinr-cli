// @ts-check

/**
 * Agent-version helpers shared between the TUI (`src/dashboard/`) and the
 * CLI commands. Kept in plain Node-compatible JS so both the bundled
 * dashboard and the un-bundled CLI can import directly.
 *
 * The agent reports its version as a git-describe string (e.g.
 * `v1.6.5-2-g7c3d192` for a dev build off `v1.6.5`). Grouping those
 * together by release tag gives a readable rollout picture without an
 * explosion of near-identical rows.
 */

/** Drop the git-describe suffix so dev builds group with their release. */
export function normalizeAgentVersion(raw) {
    if (!raw) return null;
    const m = String(raw).match(/^(v?\d+\.\d+\.\d+)/);
    return m ? m[1] : raw;
}

function semverTriple(v) {
    if (!v) return null;
    const m = String(v).match(/^v?(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Descending comparator — newer first. Non-semver values sink to the
 * bottom alphabetically, so rogue strings never claim "newest".
 */
export function compareAgentVersions(a, b) {
    const ta = semverTriple(a);
    const tb = semverTriple(b);
    if (ta && tb) {
        for (let i = 0; i < 3; i++) {
            if (ta[i] !== tb[i]) return tb[i] - ta[i];
        }
        return 0;
    }
    if (ta) return -1;
    if (tb) return 1;
    return String(b).localeCompare(String(a));
}

/**
 * Partition a map of `deviceId -> reported-version-string` against a
 * target version.
 *
 * Returns:
 *   - `outdated`: device IDs strictly older than `target`
 *   - `current`:  device IDs already at `target`
 *   - `unknown`:  device IDs we have no version for (never reported a
 *     sample, or reported a non-parseable string). These are *not*
 *     upgraded by default — we don't want to "fix" something we can't
 *     identify.
 */
export function classifyAgainst(target, deviceVersions) {
    const outdated = [];
    const current = [];
    const unknown = [];
    for (const [id, raw] of Object.entries(deviceVersions)) {
        const v = normalizeAgentVersion(raw);
        if (!v) {
            unknown.push(id);
            continue;
        }
        const d = compareAgentVersions(v, target);
        if (d > 0) outdated.push(id);
        else current.push(id);
    }
    return { outdated, current, unknown };
}
