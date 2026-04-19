import React, { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../theme.js';
import { Panel } from './Panel.jsx';
import { Sparkline } from './Sparkline.jsx';
import { Bar, colorForPct } from './Sparkline.jsx';
import {
    deviceHealth,
    fleetCounts,
    activeAlerts,
    agentVersionCounts,
    deviceKindCounts,
} from '../lib/status.js';

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

function statusDot(h) {
    if (h === 'on') return { glyph: '●', color: theme.lime };
    if (h === 'warn') return { glyph: '▲', color: theme.amber };
    if (h === 'bad') return { glyph: '✕', color: theme.red };
    return { glyph: '○', color: theme.fgFaint };
}

function MiniBar({ value, width = 10 }) {
    const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
    const filled = Math.round((pct / 100) * width);
    const color = value == null ? theme.fgFaint : colorForPct(value);
    return (
        <Text>
            <Text color={color}>{'█'.repeat(filled)}</Text>
            <Text color={theme.borderDim}>{'░'.repeat(width - filled)}</Text>
        </Text>
    );
}

function FleetListRow({ device, sample, health }) {
    const dot = statusDot(health);
    const cpu = sample?.cpu?.usage;
    const mem = sample?.memory?.usage;
    const hasSample = sample != null;
    const cpuStr = cpu == null ? '  —' : `${Math.round(cpu).toString().padStart(3)}%`;
    const memStr = mem == null ? '  —' : `${Math.round(mem).toString().padStart(3)}%`;
    return (
        <Box>
            <Box width={2}>
                <Text color={dot.color}>{dot.glyph}</Text>
            </Box>
            <Box flexGrow={1} flexBasis={0} flexShrink={1} minWidth={0}>
                <Text color={theme.fg} wrap="truncate-end">
                    {device.device}
                </Text>
            </Box>
            <Box width={12} marginRight={1}>
                {hasSample ? (
                    <MiniBar value={cpu} width={10} />
                ) : (
                    <Text color={theme.fgFaint}>{'·'.repeat(10)}</Text>
                )}
            </Box>
            <Box width={5} marginRight={2} justifyContent="flex-end">
                <Text color={cpu == null ? theme.fgFaint : colorForPct(cpu)}>{cpuStr}</Text>
            </Box>
            <Box width={4}>
                <Text color={theme.fgFaint}>cpu</Text>
            </Box>
            <Box width={5} marginRight={1} justifyContent="flex-end">
                <Text color={mem == null ? theme.fgFaint : colorForPct(mem)}>{memStr}</Text>
            </Box>
            <Box width={4}>
                <Text color={theme.fgFaint}>mem</Text>
            </Box>
        </Box>
    );
}

function VersionBar({ v, count, max, level }) {
    const width = 16;
    const filled = Math.max(1, Math.round((count / max) * width));
    const color = level === 'new' ? theme.lime : level === 'old' ? theme.amber : theme.red;
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

function AlertRow({ a }) {
    const color = a.sev === 'crit' ? theme.red : a.sev === 'warn' ? theme.amber : theme.accent;
    const sev = a.sev === 'crit' ? '●' : a.sev === 'warn' ? '▲' : 'i';
    return (
        <Box>
            <Box width={2}>
                <Text color={color} bold>
                    {sev}
                </Text>
            </Box>
            <Text wrap="truncate-end">
                <Text color={theme.fg}>{a.dev}</Text>
                <Text color={theme.fgDim}> · {a.msg}</Text>
            </Text>
        </Box>
    );
}

function EventRow({ e, isFirst }) {
    const tagColor =
        e.kind === 'join'
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

export function OverviewTab({ devices, samples, history, events }) {
    const counts = useMemo(() => fleetCounts(devices, samples), [devices, samples]);
    const alerts = useMemo(() => activeAlerts(devices, samples), [devices, samples]);
    const versions = useMemo(() => agentVersionCounts(devices, samples), [devices, samples]);
    const kinds = useMemo(() => deviceKindCounts(devices), [devices]);
    const { stdout } = useStdout();
    // Right column splits its height between AGENT VERSIONS and EVENTS; same
    // idea for left column with FLEET and ACTIVE ALERTS. Reserve header (3) +
    // footer (3) for the outer chrome, then half the remainder to each panel,
    // minus 4 rows of per-panel chrome (border, title, margin).
    const halfPanelRows = Math.max(
        4,
        Math.floor(((stdout?.rows || 40) - 6) / 2) - 4,
    );
    const sortedFleet = useMemo(() => {
        const order = { bad: 0, warn: 1, on: 2, off: 3 };
        return [...devices].sort((a, b) => {
            const ha = deviceHealth(a, samples?.[a.device]);
            const hb = deviceHealth(b, samples?.[b.device]);
            const oo = order[ha] - order[hb];
            if (oo !== 0) return oo;
            return a.device.localeCompare(b.device);
        });
    }, [devices, samples]);

    const lastCpu = history.cpu?.at?.(-1);
    const lastMem = history.mem?.at?.(-1);
    const lastDisk = history.disk?.at?.(-1);

    const versionsMax = Math.max(1, ...versions.map(([, c]) => c));
    const versionRows = versions.map(([v, c], i) => ({
        v,
        c,
        level: i === 0 ? 'new' : i === 1 ? 'old' : 'ancient',
    }));
    const stale = versions.slice(1).reduce((a, [, c]) => a + c, 0);

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
                        <Box marginTop={1} flexWrap="wrap">
                            {kinds.slice(0, 6).map(([k, c]) => (
                                <Box key={k} marginRight={2}>
                                    <Text color={theme.fgDim}>{k} </Text>
                                    <Text color={theme.accent} bold>
                                        {c}
                                    </Text>
                                </Box>
                            ))}
                        </Box>
                    )}
                </Panel>
                <Panel
                    title="ACTIVE ALERTS"
                    sub={`${alerts.length}`}
                    right={
                        alerts.length > 0 ? (
                            <Text color={theme.red}>
                                {alerts.filter((a) => a.sev === 'crit').length} crit ·{' '}
                                {alerts.filter((a) => a.sev === 'warn').length} warn
                            </Text>
                        ) : null
                    }
                >
                    {alerts.length === 0 && <Text color={theme.fgFaint}>no active alerts</Text>}
                    {alerts.slice(0, halfPanelRows).map((a, i) => (
                        <AlertRow key={i} a={a} />
                    ))}
                </Panel>
            </Box>

            {/* Middle column: Fleet list */}
            <Box width="40%" flexDirection="column">
                <Panel
                    title="FLEET"
                    sub={`${devices.length} devices`}
                    right={
                        <Box gap={1}>
                            <Text>
                                <Text color={theme.lime}>● </Text>
                                <Text color={theme.fgDim}>on</Text>
                            </Text>
                            <Text>
                                <Text color={theme.amber}>▲ </Text>
                                <Text color={theme.fgDim}>warn</Text>
                            </Text>
                            <Text>
                                <Text color={theme.red}>✕ </Text>
                                <Text color={theme.fgDim}>crit</Text>
                            </Text>
                            <Text>
                                <Text color={theme.fgFaint}>○ </Text>
                                <Text color={theme.fgDim}>off</Text>
                            </Text>
                        </Box>
                    }
                >
                    <Box flexDirection="column">
                        {sortedFleet.map((d) => {
                            const sample = samples?.[d.device];
                            const health = deviceHealth(d, sample);
                            return (
                                <FleetListRow
                                    key={d.device}
                                    device={d}
                                    sample={sample}
                                    health={health}
                                />
                            );
                        })}
                    </Box>
                </Panel>
            </Box>

            {/* Right column: versions + events */}
            <Box width="28%" flexDirection="column">
                <Panel title="AGENT VERSIONS" sub="deployed" flexGrow={0} flexShrink={0}>
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
                    {stale > 0 && (
                        <Box marginTop={1}>
                            <Text color={theme.amber}>⚠ </Text>
                            <Text color={theme.fgDim}>{stale} pending upgrade</Text>
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
                    {events.slice(0, halfPanelRows).map((e, i) => (
                        <EventRow key={`${e.t}-${e.dev}-${i}`} e={e} isFirst={i === 0} />
                    ))}
                </Panel>
            </Box>
        </Box>
    );
}
