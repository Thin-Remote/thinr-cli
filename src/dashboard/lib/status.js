import { ALARM_SEVERITY } from '../../../lib/alarms.js';
import { debugLog } from '../../../lib/debug-log.js';

// Health = single source of truth across the dashboard. Severity wins over
// connection state — a critical alarm on a disconnected agent (e.g.
// "Missing Monitoring Data") should still surface as ✕, not as ○.
//   - 'bad' : alarm severity ≥ HIGH (regardless of connection)
//   - 'warn': alarm severity LOW or MEDIUM (regardless of connection)
//   - 'off' : not connected and no active alarm
//   - 'on'  : connected, no active alarm
export function deviceHealth(device, alarmSeverity) {
    const sev = alarmSeverity ?? ALARM_SEVERITY.NONE;
    if (sev >= ALARM_SEVERITY.HIGH) return 'bad';
    if (sev >= ALARM_SEVERITY.LOW) return 'warn';
    if (!device?.connection?.active) return 'off';
    return 'on';
}

// Map deviceId → highest active alarm severity. Filters by `origin.source`
// so user-scoped alarms don't leak into a per-device count.
//
// Alarms from rules driven by asset hostname/name occasionally arrive with
// `origin.id` that doesn't match `device.device`. To still surface those on
// the matching device row, we also resolve via `origin.name → device.name`
// as a fallback — `devices` is optional, callers that pass it get the
// extra coverage.
export function maxSeverityByDevice(instances, devices) {
    const map = new Map();
    if (!instances) return map;
    const idSet = new Set();
    const nameToId = new Map();
    if (devices) {
        for (const d of devices) {
            if (!d?.device) continue;
            idSet.add(d.device);
            if (d.name) nameToId.set(d.name, d.device);
        }
    }
    const bump = (key, sev) => {
        if (!key) return;
        const cur = map.get(key) ?? ALARM_SEVERITY.NONE;
        if (sev > cur) map.set(key, sev);
    };
    const unmatched = [];
    for (const i of instances) {
        if (i?.origin?.source !== 'device') continue;
        const sev = i.severity ?? ALARM_SEVERITY.NONE;
        const id = i.origin.id;
        const name = i.origin.name;
        // Prefer id when it resolves to a known device; otherwise try name.
        if (id && idSet.has(id)) {
            bump(id, sev);
        } else if (name && nameToId.has(name)) {
            bump(nameToId.get(name), sev);
        } else {
            // No match: keep keyed by id so a later device-list refresh
            // can still pick it up, and surface it to the debug log so
            // the cause (different scope, asset-not-device origin, etc.)
            // is visible without spelunking the WS frames.
            if (id) bump(id, sev);
            unmatched.push({ id, name, instance: i.instance, severity: sev });
        }
    }
    if (unmatched.length > 0 && devices) {
        debugLog('alarms:match', 'unmatched-origins', {
            unmatched_count: unmatched.length,
            sample: unmatched.slice(0, 5),
        });
    }
    return map;
}

export function fleetCounts(devices, alarmSeverityByDevice) {
    const out = { total: devices.length, online: 0, offline: 0, warn: 0, bad: 0 };
    for (const d of devices) {
        const h = deviceHealth(d, alarmSeverityByDevice?.get(d.device));
        if (h === 'off') out.offline++;
        else out.online++;
        if (h === 'warn') out.warn++;
        else if (h === 'bad') out.bad++;
    }
    return out;
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

export const UNASSIGNED_PRODUCT_KEY = '__unassigned__';

export function deviceKindCounts(devices) {
    const m = new Map();
    for (const d of devices) {
        const kind = d.product || UNASSIGNED_PRODUCT_KEY;
        m.set(kind, (m.get(kind) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
