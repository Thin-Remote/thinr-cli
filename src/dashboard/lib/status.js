// Derives a richer health status for a device by combining its connection
// state with the latest monitoring sample (if any). Backend doesn't yet emit a
// severity field, so the thresholds live here:
//   - bad   : CPU/MEM ≥ 90 or DISK ≥ 95
//   - warn  : CPU/MEM ≥ 75 or DISK ≥ 85
//   - on    : online with no thresholds tripped
//   - off   : not connected
//   - 'on?' : connected but no monitoring sample yet
const BAD_CPU = 90,
    BAD_MEM = 90,
    BAD_DISK = 95;
const WARN_CPU = 75,
    WARN_MEM = 75,
    WARN_DISK = 85;

export function deviceHealth(device, sample) {
    if (!device?.connection?.active) return 'off';
    if (!sample) return 'on';
    const cpu = sample.cpu?.usage;
    const mem = sample.memory?.usage;
    const disk = sample.disk?.root?.usage;
    if (cpu >= BAD_CPU || mem >= BAD_MEM || disk >= BAD_DISK) return 'bad';
    if (cpu >= WARN_CPU || mem >= WARN_MEM || disk >= WARN_DISK) return 'warn';
    return 'on';
}

export function fleetCounts(devices, samples) {
    const out = { total: devices.length, online: 0, offline: 0, warn: 0, bad: 0 };
    for (const d of devices) {
        const h = deviceHealth(d, samples?.[d.device]);
        if (h === 'off') out.offline++;
        else out.online++;
        if (h === 'warn') out.warn++;
        else if (h === 'bad') out.bad++;
    }
    return out;
}

export function activeAlerts(devices, samples) {
    const alerts = [];
    for (const d of devices) {
        const s = samples?.[d.device];
        const id = d.device;
        if (!d.connection?.active) {
            // Surface "agent offline" only when we used to see them — heuristic
            // is just "had a last_connection at some point".
            if (d.last_connection_ts) {
                alerts.push({ sev: 'crit', dev: id, msg: 'agent offline' });
            }
            continue;
        }
        if (!s) continue;
        const cpu = s.cpu?.usage;
        const mem = s.memory?.usage;
        const disk = s.disk?.root?.usage;
        if (disk >= BAD_DISK) alerts.push({ sev: 'crit', dev: id, msg: `disk ${Math.round(disk)}% root volume` });
        else if (disk >= WARN_DISK) alerts.push({ sev: 'warn', dev: id, msg: `disk ${Math.round(disk)}% root volume` });
        if (cpu >= BAD_CPU) alerts.push({ sev: 'crit', dev: id, msg: `cpu ${Math.round(cpu)}% sustained` });
        else if (cpu >= WARN_CPU) alerts.push({ sev: 'warn', dev: id, msg: `cpu ${Math.round(cpu)}%` });
        if (mem >= BAD_MEM) alerts.push({ sev: 'crit', dev: id, msg: `mem ${Math.round(mem)}%` });
        else if (mem >= WARN_MEM) alerts.push({ sev: 'warn', dev: id, msg: `mem ${Math.round(mem)}%` });
    }
    // Critical first, then warn.
    alerts.sort((a, b) => (a.sev === b.sev ? 0 : a.sev === 'crit' ? -1 : 1));
    return alerts;
}

// Version helpers live in `lib/agent-versions.js` so the CLI can reuse
// them without pulling dashboard-specific code. Re-exported from here for
// call-sites that already import `normalizeAgentVersion` / `compareAgentVersions`
// from the dashboard module.
import { normalizeAgentVersion, compareAgentVersions } from '../../../lib/agent-versions.js';
export { normalizeAgentVersion, compareAgentVersions };

// Returns [version, count] tuples sorted newest-first by semver. Callers that
// need popularity order can re-sort. Sorting by semver is what lets the UI
// label a row as "outdated" without relying on a popularity heuristic (which
// misfires the moment a newer release rolls out to <50% of the fleet).
export function agentVersionCounts(devices, samples) {
    const m = new Map();
    for (const d of devices) {
        const s = samples?.[d.device];
        const v = normalizeAgentVersion(s?.agent?.version);
        if (!v) continue;
        m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => compareAgentVersions(a[0], b[0]));
}

// Devices whose reported agent version is older than `target`. Devices without
// a known version (never reported a sample, or reported a string that doesn't
// parse) are skipped — we don't want to "upgrade" something we can't identify.
export function outdatedDevices(devices, samples, target) {
    if (!target) return [];
    const out = [];
    for (const d of devices) {
        const s = samples?.[d.device];
        const v = normalizeAgentVersion(s?.agent?.version);
        if (!v) continue;
        if (compareAgentVersions(v, target) > 0) out.push(d);
    }
    return out;
}

export function deviceKindCounts(devices) {
    const m = new Map();
    for (const d of devices) {
        const kind = d.product || d.type || 'device';
        m.set(kind, (m.get(kind) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
