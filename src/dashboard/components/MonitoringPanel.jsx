import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { useMonitoring } from '../hooks/useMonitoring.js';

function formatBytes(n) {
    if (n == null) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = Number(n);
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatUptime(secs) {
    if (secs == null) return '—';
    const s = Math.floor(secs);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
}

function colorForPct(p) {
    if (p == null) return theme.muted;
    if (p >= 90) return theme.err;
    if (p >= 70) return theme.warn;
    return theme.ok;
}

function Bar({ value, width = 20 }) {
    const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
    const filled = Math.round((pct / 100) * width);
    const empty = width - filled;
    const color = colorForPct(value);
    return (
        <Text>
            <Text color={theme.dim}>[</Text>
            <Text color={color}>{'█'.repeat(filled)}</Text>
            <Text color={theme.dim}>{'░'.repeat(empty)}</Text>
            <Text color={theme.dim}>]</Text>
        </Text>
    );
}

function Spark({ series, width = 20 }) {
    const data = (series || []).filter((v) => v != null);
    if (data.length < 2) return <Text>{' '.repeat(width)}</Text>;
    const glyphs = '▁▂▃▄▅▆▇█';
    const slice = data.slice(-width);
    const out = slice
        .map((v) => {
            const n = Math.max(0, Math.min(100, v));
            const i = Math.min(glyphs.length - 1, Math.floor((n / 100) * (glyphs.length - 1)));
            return glyphs[i];
        })
        .join('');
    const pad = width - slice.length;
    return (
        <Text>
            {pad > 0 && ' '.repeat(pad)}
            <Text color={theme.muted}>{out}</Text>
        </Text>
    );
}

function Metric({ name, value, suffix, bar, spark, detail }) {
    const color = colorForPct(value);
    const pct = value == null ? '—' : `${Math.round(value)}%`;
    return (
        <Box>
            <Box width={7}>
                <Text color={theme.muted}>{name}</Text>
            </Box>
            {bar && <Bar value={value} />}
            <Box marginLeft={1} width={5}>
                <Text color={color}>{pct}</Text>
            </Box>
            {spark && (
                <Box marginLeft={1}>
                    <Spark series={spark} width={20} />
                </Box>
            )}
            {detail && (
                <Box marginLeft={2}>
                    <Text color={theme.dim}>{detail}</Text>
                </Box>
            )}
        </Box>
    );
}

export function MonitoringPanel({ deviceId, focused }) {
    const { latest, history, error, loading } = useMonitoring(deviceId);
    const borderColor = focused ? theme.borderFocus : theme.border;

    const memUsed =
        latest?.memory?.total != null && latest?.memory?.available != null
            ? latest.memory.total - latest.memory.available
            : null;
    const memDetail =
        memUsed != null && latest?.memory?.total != null
            ? `${formatBytes(memUsed)} / ${formatBytes(latest.memory.total)}`
            : undefined;
    const diskDetail =
        latest?.disk?.root?.available != null && latest?.disk?.root?.total != null
            ? `${formatBytes(latest.disk.root.total - latest.disk.root.available)} / ${formatBytes(latest.disk.root.total)}`
            : undefined;
    const cpuDetail = (() => {
        const bits = [];
        if (latest?.cpu?.cores != null) bits.push(`${latest.cpu.cores} cores`);
        if (latest?.cpu?.temperature != null)
            bits.push(`${latest.cpu.temperature.toFixed(1)}°C`);
        return bits.length ? bits.join(' · ') : undefined;
    })();

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={borderColor}
            paddingX={1}
            flexGrow={1}
        >
            <Box marginBottom={1}>
                <Text color={theme.muted}>MONITORING</Text>
                {deviceId && (
                    <Text color={theme.dim}>
                        {' '}
                        · <Text color={theme.fg}>{deviceId}</Text>
                    </Text>
                )}
            </Box>

            {!deviceId && <Text color={theme.dim}>select a device</Text>}
            {deviceId && loading && !latest && <Text color={theme.muted}>loading…</Text>}
            {deviceId && error && !latest && <Text color={theme.err}>{error}</Text>}
            {deviceId && !loading && !latest && !error && (
                <Text color={theme.dim}>no monitoring data</Text>
            )}

            {latest && (
                <Box flexDirection="column">
                    <Metric
                        name="CPU"
                        value={latest.cpu?.usage}
                        bar
                        spark={history.cpu}
                        detail={cpuDetail}
                    />
                    <Metric
                        name="MEM"
                        value={latest.memory?.usage}
                        bar
                        spark={history.mem}
                        detail={memDetail}
                    />
                    <Metric
                        name="DISK"
                        value={latest.disk?.root?.usage}
                        bar
                        spark={history.disk}
                        detail={diskDetail}
                    />

                    <Box marginTop={1} flexDirection="column">
                        {latest.load && (
                            <Box>
                                <Box width={7}>
                                    <Text color={theme.muted}>LOAD</Text>
                                </Box>
                                <Text color={theme.fg}>
                                    {[latest.load['1m'], latest.load['5m'], latest.load['15m']]
                                        .map((v) => (v != null ? v.toFixed(2) : '—'))
                                        .join(' · ')}
                                </Text>
                            </Box>
                        )}
                        {latest.uptime != null && (
                            <Box>
                                <Box width={7}>
                                    <Text color={theme.muted}>UP</Text>
                                </Box>
                                <Text color={theme.fg}>{formatUptime(latest.uptime)}</Text>
                            </Box>
                        )}
                        {latest.agent?.version && (
                            <Box>
                                <Box width={7}>
                                    <Text color={theme.muted}>AGENT</Text>
                                </Box>
                                <Text color={theme.dim}>{latest.agent.version}</Text>
                            </Box>
                        )}
                    </Box>
                </Box>
            )}
        </Box>
    );
}
