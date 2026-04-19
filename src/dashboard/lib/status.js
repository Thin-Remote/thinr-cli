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

// Normalize the agent version string to its release tag, dropping the git
// describe suffix (e.g. `v1.5.0-2-g7c3d192` -> `v1.5.0`). Keeps the bar chart
// readable and groups dev builds with their parent release.
export function normalizeAgentVersion(raw) {
    if (!raw) return null;
    // Strip `-N-g<sha>` describe suffix.
    const m = raw.match(/^(v?\d+\.\d+\.\d+)/);
    return m ? m[1] : raw;
}

export function agentVersionCounts(devices, samples) {
    const m = new Map();
    for (const d of devices) {
        const s = samples?.[d.device];
        const v = normalizeAgentVersion(s?.agent?.version);
        if (!v) continue;
        m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export function deviceKindCounts(devices) {
    const m = new Map();
    for (const d of devices) {
        const kind = d.product || d.type || 'device';
        m.set(kind, (m.get(kind) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
