import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { Panel } from './Panel.jsx';
import { ALARM_SEVERITY, ALARM_STATE } from '../../../lib/alarms.js';

const SEVERITY_STYLE = {
    [ALARM_SEVERITY.CRITICAL]: { glyph: '●', color: theme.red, label: 'CRIT' },
    [ALARM_SEVERITY.HIGH]: { glyph: '●', color: theme.red, label: 'HIGH' },
    [ALARM_SEVERITY.MEDIUM]: { glyph: '▲', color: theme.amber, label: 'MED' },
    [ALARM_SEVERITY.LOW]: { glyph: 'i', color: theme.accent, label: 'LOW' },
    [ALARM_SEVERITY.NONE]: { glyph: '·', color: theme.fgDim, label: '—' },
};

const STATE_STYLE = {
    [ALARM_STATE.NONE]: { color: theme.fgDim, label: 'PEND' },
    [ALARM_STATE.ACTIVATED]: { color: theme.red, label: 'ACTIVE' },
    [ALARM_STATE.ACKNOWLEDGED]: { color: theme.amber, label: 'ACK' },
    [ALARM_STATE.LATCHED]: { color: theme.amber, label: 'LATCHED' },
    [ALARM_STATE.SHELVED]: { color: theme.fgDim, label: 'SHELVED' },
    [ALARM_STATE.CLEARED]: { color: theme.green, label: 'CLEARED' },
};

function severityStyle(sev) {
    return SEVERITY_STYLE[sev] ?? SEVERITY_STYLE[ALARM_SEVERITY.NONE];
}

function stateStyle(state) {
    return STATE_STYLE[state] ?? STATE_STYLE[ALARM_STATE.NONE];
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

function HeaderCell({ label, width, align = 'left' }) {
    return (
        <Box width={width} justifyContent={align === 'right' ? 'flex-end' : 'flex-start'}>
            <Text color={theme.fgFaint}>{label}</Text>
        </Box>
    );
}

function AlarmRow({ inst, devWidth, nameWidth, now }) {
    const sev = severityStyle(inst.severity);
    const st = stateStyle(inst.state);
    const dev = inst.origin?.name || inst.origin?.id || '—';
    const name = inst.name || inst.alarm?.rule || '—';
    const initiated = activationMs(inst);
    const since = initiated != null ? durationLabel(now - initiated) : '—';
    return (
        <Box>
            <Box width={6}>
                <Text color={sev.color} bold>
                    {sev.glyph} {sev.label}
                </Text>
            </Box>
            <Box width={9}>
                <Text color={st.color} bold>
                    {st.label}
                </Text>
            </Box>
            <Box width={devWidth + 2}>
                <Text color={theme.fg} wrap="truncate-end">
                    {dev}
                </Text>
            </Box>
            <Box width={nameWidth + 2}>
                <Text color={theme.fgDim} wrap="truncate-end">
                    {name}
                </Text>
            </Box>
            <Box flexGrow={1} justifyContent="flex-end">
                <Text color={theme.fgDim}>{since}</Text>
            </Box>
        </Box>
    );
}

function countsBySeverity(instances) {
    const out = { crit: 0, high: 0, med: 0, low: 0 };
    for (const i of instances) {
        if (i.severity === ALARM_SEVERITY.CRITICAL) out.crit++;
        else if (i.severity === ALARM_SEVERITY.HIGH) out.high++;
        else if (i.severity === ALARM_SEVERITY.MEDIUM) out.med++;
        else if (i.severity === ALARM_SEVERITY.LOW) out.low++;
    }
    return out;
}

export function AlertsTab({ alarms }) {
    const { instances, loading, error } = alarms;
    const now = Date.now();
    const counts = useMemo(() => countsBySeverity(instances), [instances]);
    const devWidth = useMemo(
        () =>
            instances.reduce(
                (w, i) =>
                    Math.max(w, (i.origin?.name || i.origin?.id || '').length),
                12,
            ),
        [instances],
    );
    const nameWidth = useMemo(
        () =>
            instances.reduce(
                (w, i) => Math.max(w, (i.name || i.alarm?.rule || '').length),
                16,
            ),
        [instances],
    );

    let body;
    if (error) {
        body = (
            <Text color={theme.red}>
                failed to load alarms: {error?.message || String(error)}
            </Text>
        );
    } else if (loading && instances.length === 0) {
        body = <Text color={theme.fgFaint}>loading alarms…</Text>;
    } else if (instances.length === 0) {
        body = <Text color={theme.fgFaint}>no active alarms — fleet is healthy</Text>;
    } else {
        body = (
            <>
                <Box marginBottom={1}>
                    <HeaderCell label="severity" width={6} />
                    <HeaderCell label="state" width={9} />
                    <HeaderCell label="device" width={devWidth + 2} />
                    <HeaderCell label="rule" width={nameWidth + 2} />
                    <HeaderCell label="since" width={8} align="right" />
                </Box>
                {instances.map((inst) => (
                    <AlarmRow
                        key={inst.instance}
                        inst={inst}
                        devWidth={devWidth}
                        nameWidth={nameWidth}
                        now={now}
                    />
                ))}
            </>
        );
    }

    return (
        <Box flexGrow={1}>
            <Panel
                title="ALERTS"
                sub={`${instances.length} active`}
                right={
                    <Text>
                        <Text color={theme.red} bold>
                            {counts.crit + counts.high}
                        </Text>
                        <Text color={theme.fgDim}> crit · </Text>
                        <Text color={theme.amber} bold>
                            {counts.med}
                        </Text>
                        <Text color={theme.fgDim}> med · </Text>
                        <Text color={theme.accent} bold>
                            {counts.low}
                        </Text>
                        <Text color={theme.fgDim}> low</Text>
                    </Text>
                }
            >
                {body}
            </Panel>
        </Box>
    );
}
