import React, { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { Panel } from './Panel.jsx';
import { Sparkline } from './Sparkline.jsx';
import { Bar, colorForPct } from './Sparkline.jsx';
import { DevicesPanel } from './DevicesPanel.jsx';
import {
    fleetCounts,
    agentVersionCounts,
    compareAgentVersions,
    deviceKindCounts,
    UNASSIGNED_PRODUCT_KEY,
} from '../lib/status.js';
import { ALARM_SEVERITY, ALARM_STATE } from '../../../lib/alarms.js';
import { useFocusable, useTabCycle } from '../lib/focus.js';

const FLEET_HINT = [
    { k: '1-5', label: 'tabs' },
    { k: 'tab', label: 'panel' },
    { k: '↑↓', label: 'nav' },
    { k: 's', label: 'sort' },
    { k: '/', label: 'filter' },
    { k: 'enter', label: 'detail' },
    { k: 'q', label: 'quit' },
];

const ALERTS_HINT = [
    { k: '1-5', label: 'tabs' },
    { k: 'tab', label: 'panel' },
    { k: 'v', label: 'view' },
    { k: 'q', label: 'quit' },
];

const VERSIONS_HINT = [
    { k: '1-5', label: 'tabs' },
    { k: 'tab', label: 'panel' },
    { k: 'u', label: 'upgrade' },
    { k: 'q', label: 'quit' },
];

function Kpi({ label, value, color = theme.fg, suffix }) {
    return (
        <Box flexDirection="column" flexGrow={1}>
            <Text>
                <Text color={color} bold>
                    {value}
                </Text>
                {suffix && <Text color={theme.fgFaint}>{suffix}</Text>}
            </Text>
            <Text color={theme.fgDim}>{label}</Text>
        </Box>
    );
}

function MiniMetric({ label, value, history, color }) {
    const display = value == null ? '—' : `${Math.round(value)}%`;
    return (
        <Box>
            <Box width={5}>
                <Text color={theme.fgDim}>{label}</Text>
            </Box>
            <Bar value={value ?? 0} width={10} color={colorForPct(value)} />
            <Box marginLeft={1}>
                <Sparkline series={history} width={12} color={color} />
            </Box>
            <Box width={6} justifyContent="flex-end">
                <Text color={theme.fg}>{display}</Text>
            </Box>
        </Box>
    );
}

function VersionBar({ v, count, max, level }) {
    const width = 16;
    const filled = Math.max(1, Math.round((count / max) * width));
    // level maps semantic rows to palette slots:
    //   target  → current/desired version (lime)
    //   old     → behind by one minor/patch (amber)
    //   ancient → more than one release behind (red)
    const color =
        level === 'target' ? theme.lime : level === 'old' ? theme.amber : theme.red;
    return (
        <Box>
            <Box width={9}>
                <Text color={color}>{v}</Text>
            </Box>
            <Text color={color}>{'█'.repeat(filled)}</Text>
            <Text color={theme.borderDim}>{'░'.repeat(width - filled)}</Text>
            <Box width={4} justifyContent="flex-end">
                <Text color={theme.fgDim}>{count}</Text>
            </Box>
        </Box>
    );
}

function severityVisual(sev) {
    if (sev === ALARM_SEVERITY.CRITICAL || sev === ALARM_SEVERITY.HIGH) {
        return { color: theme.red, glyph: '●' };
    }
    if (sev === ALARM_SEVERITY.MEDIUM) return { color: theme.amber, glyph: '▲' };
    if (sev === ALARM_SEVERITY.LOW) return { color: theme.accent, glyph: 'i' };
    return { color: theme.fgDim, glyph: '·' };
}

function AlarmGroupRow({ group, now }) {
    const { color, glyph } = severityVisual(group.severity);
    return (
        <Box flexDirection="column" marginBottom={1}>
            <Box>
                <Box width={2}>
                    <Text color={color} bold>
                        {glyph}
                    </Text>
                </Box>
                <Box width={3} justifyContent="flex-end" marginRight={1}>
                    <Text color={theme.fg} bold>
                        {group.count}
                    </Text>
                </Box>
                <Text color={theme.fg}>{group.name}</Text>
            </Box>
            <Box marginLeft={6} flexDirection="column">
                {group.devices.map((d, i) => {
                    const tag = stateLabel(d.state);
                    const since =
                        d.initiated != null ? durationLabel(now - d.initiated) : '—';
                    return (
                        <Box key={`${d.name}-${i}`}>
                            <Box flexGrow={1} flexBasis={0} minWidth={0}>
                                <Text color={theme.fgDim} wrap="truncate-end">
                                    {d.name}
                                </Text>
                            </Box>
                            <Box width={6} justifyContent="flex-end" marginLeft={1}>
                                <Text color={d.value ? theme.fg : theme.fgFaint}>
                                    {d.value || '—'}
                                </Text>
                            </Box>
                            <Box width={5} justifyContent="flex-end" marginLeft={1}>
                                <Text color={theme.fgDim}>{since}</Text>
                            </Box>
                            <Box width={6} justifyContent="flex-end" marginLeft={1}>
                                <Text color={stateColor(d.state)}>{tag}</Text>
                            </Box>
                        </Box>
                    );
                })}
            </Box>
        </Box>
    );
}

function durationLabel(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d`;
}

function activationMs(inst) {
    const v = inst?.activation?.initiated;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
        const t = Date.parse(v);
        return Number.isFinite(t) ? t : null;
    }
    if (v && typeof v === 'object' && v.$date != null) {
        if (typeof v.$date === 'number') return v.$date;
        const t = Date.parse(v.$date);
        return Number.isFinite(t) ? t : null;
    }
    return null;
}

function stateTag(state) {
    if (state === ALARM_STATE.ACKNOWLEDGED) return 'ACK';
    if (state === ALARM_STATE.LATCHED) return 'LATCH';
    if (state === ALARM_STATE.SHELVED) return 'SHELV';
    return null;
}

function stateLabel(state) {
    if (state === ALARM_STATE.NONE) return 'PEND';
    if (state === ALARM_STATE.ACTIVATED) return 'ACTIVE';
    if (state === ALARM_STATE.CLEARED) return 'CLEAR';
    return stateTag(state) || '';
}

function stateColor(state) {
    if (state === ALARM_STATE.ACTIVATED) return theme.red;
    if (
        state === ALARM_STATE.ACKNOWLEDGED ||
        state === ALARM_STATE.LATCHED ||
        state === ALARM_STATE.SHELVED
    ) {
        return theme.amber;
    }
    return theme.fgDim;
}

// Pulls a compact display value from `evaluation.last_values`. The map
// usually has a single key (the field that drove the alarm rule). Numbers
// in the 0..100 range render as percentages — that's how every default
// monitoring rule (cpu/mem/disk/swap usage) is parameterised.
function evaluationValue(inst) {
    const lv = inst?.evaluation?.last_values;
    if (!lv || typeof lv !== 'object') return null;
    const keys = Object.keys(lv);
    if (keys.length === 0) return null;
    const raw = lv[keys[0]];
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return String(raw);
    if (n >= 0 && n <= 100) return `${Math.round(n)}%`;
    if (Math.abs(n) >= 1000) return n.toFixed(0);
    if (Math.abs(n) >= 10) return n.toFixed(1);
    return n.toFixed(2);
}

function AlarmInstanceRow({ inst, hostWidth, now }) {
    const { color, glyph } = severityVisual(inst.severity);
    const dev = inst.origin?.name || inst.origin?.id || '—';
    const label = inst.name || inst.alarm?.rule || 'alarm';
    const initiated = activationMs(inst);
    const since = initiated != null ? durationLabel(now - initiated) : '—';
    const value = evaluationValue(inst);
    const stTag = stateLabel(inst.state);
    return (
        <Box>
            <Box width={2}>
                <Text color={color} bold>
                    {glyph}
                </Text>
            </Box>
            <Box width={hostWidth + 2}>
                <Text color={theme.fg} wrap="truncate-end">
                    {dev}
                </Text>
            </Box>
            <Box flexGrow={1} flexBasis={0} minWidth={0}>
                <Text color={theme.fgDim} wrap="truncate-end">
                    {label}
                </Text>
            </Box>
            <Box width={6} justifyContent="flex-end" marginLeft={1}>
                <Text color={value ? theme.fg : theme.fgFaint}>
                    {value || '—'}
                </Text>
            </Box>
            <Box width={5} justifyContent="flex-end" marginLeft={1}>
                <Text color={theme.fgDim}>{since}</Text>
            </Box>
            <Box width={6} justifyContent="flex-end" marginLeft={1}>
                <Text color={stateColor(inst.state)}>{stTag}</Text>
            </Box>
        </Box>
    );
}

function EventRow({ e, isFirst }) {
    // `upd` (update applied) is kept visually distinct from `join`
    // (connected). Both are "good" outcomes but they mean different things —
    // the rollout aftermath typically produces one of each per device (agent
    // swaps binary → LEAVE → JOIN on reconnect, with my synthetic UPD
    // threaded in between), so separate colors keep the log scannable.
    const tagColor =
        e.kind === 'upd'
            ? theme.accent
            : e.kind === 'join'
              ? theme.lime
              : e.kind === 'leave'
                ? theme.amber
                : e.kind === 'err'
                  ? theme.red
                  : theme.accent;
    return (
        <Box>
            <Box width={9}>
                <Text color={theme.fgFaint}>{e.t}</Text>
            </Box>
            <Box width={7}>
                <Text color={tagColor} bold>
                    {e.kind.toUpperCase()}
                </Text>
            </Box>
            <Text wrap="truncate-end">
                <Text color={theme.fg}>{e.dev}</Text>
                <Text color={theme.fgDim}> {e.msg}</Text>
            </Text>
        </Box>
    );
}

function groupMetricsByProduct(metrics) {
    const map = new Map();
    for (const m of metrics) {
        const key = m.product || '';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(m);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function formatMetricValue(v, unit) {
    if (v == null) return '—';
    if (Array.isArray(v)) return String(v.length);
    if (!Number.isFinite(Number(v))) return String(v);
    const n = Number(v);
    const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
    const formatted = rounded.toLocaleString('en-US');
    return unit ? `${formatted} ${unit}` : formatted;
}

function DistributionRows({ metric, value, lastUpdate }) {
    const ageS = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : null;
    const isPlainObject =
        value && typeof value === 'object' && !Array.isArray(value);
    const buckets = isPlainObject
        ? Object.entries(value).filter(
              ([, c]) => Number.isFinite(Number(c)) && Number(c) > 0,
          )
        : [];
    const total = buckets.reduce((acc, [, c]) => acc + Number(c), 0);
    const sorted = [...buckets].sort(
        (a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]),
    );
    return (
        <Box flexDirection="column">
            <Box>
                <Box flexGrow={1} flexBasis={0} minWidth={0}>
                    <Text color={theme.fgDim} wrap="truncate-end">
                        {metric.label || metric.name}
                    </Text>
                </Box>
                <Box width={6} justifyContent="flex-end">
                    <Text color={theme.fgFaint}>
                        {ageS == null ? '—' : `${ageS}s`}
                    </Text>
                </Box>
            </Box>
            {sorted.length === 0 ? (
                <Box marginLeft={2}>
                    <Text color={theme.fgFaint}>no samples yet</Text>
                </Box>
            ) : (
                <>
                    {sorted.map(([k, c]) => {
                        const count = Number(c);
                        const pct =
                            total > 0 ? Math.round((count / total) * 100) : 0;
                        return (
                            <Box key={k}>
                                <Box width={2} />
                                <Box flexGrow={1} flexBasis={0} minWidth={0}>
                                    <Text color={theme.fg} wrap="truncate-end">
                                        {k}
                                    </Text>
                                </Box>
                                <Box
                                    width={6}
                                    justifyContent="flex-end"
                                    marginRight={1}
                                >
                                    <Text color={theme.accent} bold>
                                        {count}
                                    </Text>
                                </Box>
                                <Box width={5} justifyContent="flex-end">
                                    <Text color={theme.fgFaint}>{pct}%</Text>
                                </Box>
                            </Box>
                        );
                    })}
                    <Box>
                        <Box width={2} />
                        <Box flexGrow={1} flexBasis={0} minWidth={0}>
                            <Text color={theme.fgDim}>total</Text>
                        </Box>
                        <Box
                            width={6}
                            justifyContent="flex-end"
                            marginRight={1}
                        >
                            <Text color={theme.fgDim} bold>
                                {total}
                            </Text>
                        </Box>
                        <Box width={5} />
                    </Box>
                </>
            )}
        </Box>
    );
}

function MetricRow({ metric, value, history, lastUpdate }) {
    if (metric.aggregation === 'distribution') {
        return (
            <DistributionRows
                metric={metric}
                value={value}
                lastUpdate={lastUpdate}
            />
        );
    }
    const ageS = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : null;
    const showSparkline = metric.visualization === 'sparkline';
    // Auto-scale against the visible window so values of any magnitude
    // (percentages, counts in the thousands) render with full dynamic range.
    const sparkMax = showSparkline
        ? Math.max(1, ...(history || []).filter((v) => Number.isFinite(v)))
        : undefined;
    return (
        <Box>
            <Box flexGrow={1} flexBasis={0} minWidth={0}>
                <Text color={theme.fgDim} wrap="truncate-end">
                    {metric.label || metric.name}
                </Text>
            </Box>
            {showSparkline && (
                <Box marginRight={1}>
                    <Sparkline
                        series={history}
                        width={14}
                        color={theme.accent}
                        max={sparkMax}
                    />
                </Box>
            )}
            <Box width={14} justifyContent="flex-end" marginRight={1}>
                <Text color={theme.accent} bold>
                    {formatMetricValue(value, metric.unit)}
                </Text>
            </Box>
            <Box width={6} justifyContent="flex-end">
                <Text color={theme.fgFaint}>{ageS == null ? '—' : `${ageS}s`}</Text>
            </Box>
        </Box>
    );
}

export function OverviewTab({
    devices,
    samples,
    history,
    cpuHistory,
    events,
    alarms,
    alarmSeverityByDevice,
    productMetrics,
    productInfo,
    latestAgentVersion,
    outdatedCount,
    upgradeState,
    selectedId,
    onSelectDevice,
    sort,
    onCycleSort,
    filter,
    filtering,
    onStartFilter,
    onConfirmDevice,
    onRequestUpgrade,
    devicesLoading,
    devicesError,
}) {
    useTabCycle('overview');

    // Two views over the same alarm list: 'rule' collapses to one row per
    // alarm rule (better for triage), 'instance' shows one row per device
    // (better when you want to spot a specific machine quickly).
    const [alarmView, setAlarmView] = useState('rule');

    const fleet = useFocusable({
        id: 'overview-fleet',
        parent: 'overview',
        hint: FLEET_HINT,
        handlers: (input, key) => {
            if (input === '/') return onStartFilter?.();
            if (input === 's') return onCycleSort?.();
            if (key.return && selectedId) return onConfirmDevice?.();
        },
    });
    const alertsHasInstances = (alarms?.instances?.length || 0) > 0;
    const alertsPanel = useFocusable({
        id: 'overview-alerts',
        parent: 'overview',
        hint: ALERTS_HINT,
        handlers: (input) => {
            if (input === 'v' && alertsHasInstances) {
                setAlarmView((v) => (v === 'rule' ? 'instance' : 'rule'));
            }
        },
    });
    const versionsPanel = useFocusable({
        id: 'overview-versions',
        parent: 'overview',
        hint: VERSIONS_HINT,
        handlers: (input) => {
            if (input === 'u') onRequestUpgrade?.();
        },
    });
    const counts = useMemo(
        () => fleetCounts(devices, alarmSeverityByDevice),
        [devices, alarmSeverityByDevice],
    );
    const alarmInstances = alarms?.instances ?? [];
    const alarmCounts = useMemo(() => {
        const out = { crit: 0, high: 0, med: 0, low: 0 };
        for (const i of alarmInstances) {
            if (i.severity === ALARM_SEVERITY.CRITICAL) out.crit++;
            else if (i.severity === ALARM_SEVERITY.HIGH) out.high++;
            else if (i.severity === ALARM_SEVERITY.MEDIUM) out.med++;
            else out.low++;
        }
        return out;
    }, [alarmInstances]);
    const alarmStateCounts = useMemo(() => {
        const out = { active: 0, ack: 0, latched: 0, shelved: 0 };
        for (const i of alarmInstances) {
            if (i.state === ALARM_STATE.ACKNOWLEDGED) out.ack++;
            else if (i.state === ALARM_STATE.LATCHED) out.latched++;
            else if (i.state === ALARM_STATE.SHELVED) out.shelved++;
            else out.active++;
        }
        return out;
    }, [alarmInstances]);
    // Group active instances by rule name. Each group lists which devices
    // are firing — easier to scan "5 boxes hit High Memory" than reading
    // the same rule name down 5 rows. Each device entry carries the value
    // and state so the row renders parity with the instance view.
    const alarmGroups = useMemo(() => {
        const groups = new Map();
        for (const i of alarmInstances) {
            const key = i.name || i.alarm?.rule || 'alarm';
            const dev = {
                name: i.origin?.name || i.origin?.id || '—',
                value: evaluationValue(i),
                state: i.state,
                initiated: activationMs(i),
            };
            const sev = i.severity ?? ALARM_SEVERITY.NONE;
            const cur = groups.get(key);
            if (cur) {
                cur.count += 1;
                cur.devices.push(dev);
                if (sev > cur.severity) cur.severity = sev;
            } else {
                groups.set(key, { name: key, count: 1, severity: sev, devices: [dev] });
            }
        }
        return [...groups.values()].sort((a, b) => {
            if (a.severity !== b.severity) return b.severity - a.severity;
            return b.count - a.count;
        });
    }, [alarmInstances]);
    const versions = useMemo(() => agentVersionCounts(devices, samples), [devices, samples]);
    const kinds = useMemo(() => deviceKindCounts(devices), [devices]);
    // Pre-compute the widest hostname across instances so the rule column
    // aligns. Capped to keep the rule column from being squeezed when one
    // device has a runaway hostname.
    const alarmHostWidth = useMemo(
        () =>
            Math.min(
                32,
                alarmInstances.reduce(
                    (w, i) =>
                        Math.max(w, (i.origin?.name || i.origin?.id || '').length),
                    14,
                ),
            ),
        [alarmInstances],
    );
    const nowTs = Date.now();

    const lastCpu = history.cpu?.at?.(-1);
    const lastMem = history.mem?.at?.(-1);
    const lastDisk = history.disk?.at?.(-1);

    const versionsMax = Math.max(1, ...versions.map(([, c]) => c));
    // Target = whichever is newer: the CDN's published `latest` or the
    // highest semver we've actually observed on the fleet. We fall back to
    // the local max so the panel stays useful when the CDN lookup fails
    // (airgap, DNS, whatever) — outdated still resolves against the newest
    // thing we know about.
    const localMax = versions[0]?.[0];
    const target = (() => {
        if (!latestAgentVersion) return localMax || null;
        if (!localMax) return latestAgentVersion;
        return compareAgentVersions(latestAgentVersion, localMax) <= 0
            ? latestAgentVersion
            : localMax;
    })();
    const versionRows = versions.map(([v, c]) => {
        let level;
        if (!target || v === target) level = 'target';
        else {
            const diff = compareAgentVersions(v, target);
            // positive = older than target; >0 but only a step away is "old",
            // anything bigger is "ancient". We approximate "a step" as the
            // row right after target in the sorted list.
            level = diff > 0 ? 'old' : 'target';
        }
        return { v, c, level };
    });
    // Re-mark rows: first non-target is "old", the rest are "ancient".
    let seenOld = false;
    for (const row of versionRows) {
        if (row.level === 'target') continue;
        if (!seenOld) {
            row.level = 'old';
            seenOld = true;
        } else {
            row.level = 'ancient';
        }
    }
    const stale =
        typeof outdatedCount === 'number'
            ? outdatedCount
            : versions
                  .filter(([v]) => target && v !== target && compareAgentVersions(v, target) > 0)
                  .reduce((a, [, c]) => a + c, 0);

    return (
        <Box flexGrow={1}>
            {/* Left column: KPIs + Active alerts */}
            <Box width="32%" flexDirection="column">
                <Panel title="FLEET" sub="realtime" right={<Text color={theme.fgFaint}>last sync 0s</Text>} flexGrow={0} flexShrink={0}>
                    <Box flexDirection="row" marginBottom={1}>
                        <Kpi label="ONLINE" value={counts.online} color={theme.lime} suffix={` / ${counts.total}`} />
                        <Kpi label="OFFLINE" value={counts.offline} color={theme.fgDim} />
                        <Kpi label="DEGRADED" value={counts.warn} color={counts.warn ? theme.amber : theme.fgDim} />
                        <Kpi label="CRITICAL" value={counts.bad} color={counts.bad ? theme.red : theme.fgDim} />
                    </Box>
                    <Box flexDirection="column" marginTop={1}>
                        <MiniMetric label="CPU" value={lastCpu} history={history.cpu} color={theme.accent} />
                        <MiniMetric label="MEM" value={lastMem} history={history.mem} color={theme.magenta} />
                        <MiniMetric label="DISK" value={lastDisk} history={history.disk} color={theme.lime} />
                    </Box>
                    {kinds.length > 0 && (
                        <Box marginTop={1} flexDirection="column">
                            {kinds.slice(0, 8).map(([k, c]) => {
                                const isUnassigned = k === UNASSIGNED_PRODUCT_KEY;
                                const label = isUnassigned
                                    ? 'no product'
                                    : productInfo?.[k]?.name || k;
                                return (
                                    <Box key={k}>
                                        <Box flexGrow={1} flexBasis={0} minWidth={0}>
                                            <Text
                                                color={
                                                    isUnassigned ? theme.fgFaint : theme.fgDim
                                                }
                                                wrap="truncate-end"
                                                italic={isUnassigned}
                                            >
                                                {label}
                                            </Text>
                                        </Box>
                                        <Box width={6} justifyContent="flex-end">
                                            <Text
                                                color={
                                                    isUnassigned ? theme.fgDim : theme.accent
                                                }
                                                bold={!isUnassigned}
                                            >
                                                {c}
                                            </Text>
                                        </Box>
                                    </Box>
                                );
                            })}
                        </Box>
                    )}
                </Panel>
                {productMetrics?.metrics?.length > 0 &&
                    groupMetricsByProduct(productMetrics.metrics).map(
                        ([product, list]) => {
                            const display =
                                productInfo?.[product]?.name || product || 'metrics';
                            return (
                                <Panel
                                    key={product}
                                    title={display.toUpperCase()}
                                    sub={`${list.length}`}
                                    right={
                                        productMetrics.error ? (
                                            <Text color={theme.red}>err</Text>
                                        ) : (
                                            <Text color={theme.fgFaint}>{product}</Text>
                                        )
                                    }
                                    flexGrow={0}
                                    flexShrink={0}
                                >
                                    {list.map((m) => {
                                        const k = `${m.product}:${m.name}`;
                                        return (
                                            <MetricRow
                                                key={k}
                                                metric={m}
                                                value={productMetrics.values[k]}
                                                history={productMetrics.history?.[k]}
                                                lastUpdate={productMetrics.lastUpdate[k]}
                                            />
                                        );
                                    })}
                                </Panel>
                            );
                        },
                    )}
                <Panel
                    title="ACTIVE ALERTS"
                    sub={alarmInstances.length > 0 ? `${alarmInstances.length}` : null}
                    focused={alertsPanel.focused}
                    right={
                        alarmInstances.length > 0 ? (
                            <Text>
                                {alarmStateCounts.ack +
                                    alarmStateCounts.latched +
                                    alarmStateCounts.shelved >
                                    0 && (
                                    <Text color={theme.fgFaint}>
                                        {alarmStateCounts.ack > 0 &&
                                            `${alarmStateCounts.ack} ack `}
                                        {alarmStateCounts.latched > 0 &&
                                            `${alarmStateCounts.latched} latched `}
                                        {alarmStateCounts.shelved > 0 &&
                                            `${alarmStateCounts.shelved} shelved `}
                                        <Text color={theme.fgFaint}>· </Text>
                                    </Text>
                                )}
                                <Text color={theme.fgFaint}>v </Text>
                                <Text color={theme.accent}>{alarmView}</Text>
                            </Text>
                        ) : null
                    }
                >
                    {alarms?.error && (
                        <Text color={theme.red} wrap="truncate-end">
                            {alarms.error?.message || 'failed to load alarms'}
                        </Text>
                    )}
                    {!alarms?.error && alarmInstances.length === 0 && (
                        <Text color={theme.fgFaint}>
                            {alarms?.loading ? 'loading alarms…' : 'no active alerts'}
                        </Text>
                    )}
                    {alarmInstances.length > 0 && (
                        <>
                            <Box flexDirection="row" marginBottom={1}>
                                <Kpi
                                    label="CRIT"
                                    value={alarmCounts.crit}
                                    color={alarmCounts.crit ? theme.red : theme.fgDim}
                                />
                                <Kpi
                                    label="HIGH"
                                    value={alarmCounts.high}
                                    color={alarmCounts.high ? theme.red : theme.fgDim}
                                />
                                <Kpi
                                    label="MED"
                                    value={alarmCounts.med}
                                    color={alarmCounts.med ? theme.amber : theme.fgDim}
                                />
                                <Kpi
                                    label="LOW"
                                    value={alarmCounts.low}
                                    color={alarmCounts.low ? theme.accent : theme.fgDim}
                                />
                            </Box>
                            {alarmView === 'rule'
                                ? alarmGroups.map((g) => (
                                      <AlarmGroupRow key={g.name} group={g} now={nowTs} />
                                  ))
                                : alarmInstances.map((inst) => (
                                      <AlarmInstanceRow
                                          key={inst.instance}
                                          inst={inst}
                                          hostWidth={alarmHostWidth}
                                          now={nowTs}
                                      />
                                  ))}
                        </>
                    )}
                </Panel>
            </Box>

            {/* Middle column: interactive devices list */}
            <Box width="40%" flexDirection="column">
                <DevicesPanel
                    devices={devices}
                    samples={samples}
                    cpuHistory={cpuHistory}
                    alarmSeverityByDevice={alarmSeverityByDevice}
                    loading={devicesLoading}
                    error={devicesError}
                    focused={fleet.focused}
                    selectedId={selectedId}
                    onSelect={onSelectDevice}
                    sort={sort}
                    filter={filter}
                    filtering={filtering}
                />
            </Box>

            {/* Right column: versions + events */}
            <Box width="28%" flexDirection="column">
                <Panel
                    title="AGENT VERSIONS"
                    sub={target ? `latest ${target}` : 'deployed'}
                    focused={versionsPanel.focused}
                    right={
                        upgradeState?.phase === 'running' ? (
                            <Text color={theme.accent}>● running</Text>
                        ) : stale > 0 ? (
                            <Text color={theme.fgFaint}>u · upgrade</Text>
                        ) : null
                    }
                    flexGrow={0}
                    flexShrink={0}
                >
                    {versionRows.length === 0 && (
                        <Text color={theme.fgFaint}>waiting for samples…</Text>
                    )}
                    {versionRows.map((r) => (
                        <VersionBar
                            key={r.v}
                            v={r.v}
                            count={r.c}
                            max={versionsMax}
                            level={r.level}
                        />
                    ))}
                    {upgradeState?.phase === 'running' && upgradeState.progress && (
                        <Box marginTop={1}>
                            <Text color={theme.accent}>↻ </Text>
                            <Text color={theme.fg}>
                                updating {upgradeState.progress.done}/{upgradeState.progress.total}…
                            </Text>
                        </Box>
                    )}
                    {upgradeState?.phase === 'done' && upgradeState.summary && (
                        <Box marginTop={1}>
                            <Text color={upgradeState.aborted ? theme.amber : theme.lime}>
                                {upgradeState.aborted ? '⚠ ' : '✓ '}
                            </Text>
                            <Text color={theme.fg}>
                                {upgradeState.summary.ok} ok · {upgradeState.summary.failed} failed
                                {upgradeState.aborted ? ` (${upgradeState.reason})` : ''}
                            </Text>
                        </Box>
                    )}
                    {upgradeState?.phase !== 'running' &&
                        upgradeState?.phase !== 'done' &&
                        stale > 0 && (
                            <Box marginTop={1}>
                                <Text color={theme.amber}>⚠ </Text>
                                <Text color={theme.fgDim}>
                                    {stale} pending upgrade
                                </Text>
                            </Box>
                        )}
                </Panel>
                <Panel
                    title="EVENTS"
                    sub="live"
                    right={
                        <Text color={theme.lime}>● streaming</Text>
                    }
                >
                    {events.length === 0 && <Text color={theme.fgFaint}>waiting for activity…</Text>}
                    {events.map((e, i) => (
                        <EventRow key={`${e.t}-${e.dev}-${i}`} e={e} isFirst={i === 0} />
                    ))}
                </Panel>
            </Box>
        </Box>
    );
}
