import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../theme.js';
import { Panel } from './Panel.jsx';
import { Sparkline, Bar, colorForPct } from './Sparkline.jsx';
import { useLogs } from '../hooks/useLogs.js';
import { deviceHealth, normalizeAgentVersion } from '../lib/status.js';

const HISTORY_LEN = 40;

// Rolling per-device history derived from the shared `samples` prop (which is
// already pushed by the fleet WS hook). No polling happens here — we just
// mirror the latest sample into local ring buffers for the sparklines.
function useDeviceHistory(deviceId, sample) {
    const historyRef = useRef({ cpu: [], mem: [], disk: [] });
    const lastDeviceRef = useRef(null);
    const [, setTick] = useState(0);

    useEffect(() => {
        if (lastDeviceRef.current !== deviceId) {
            historyRef.current = { cpu: [], mem: [], disk: [] };
            lastDeviceRef.current = deviceId;
            setTick((n) => n + 1);
        }
        if (!sample) return;
        const push = (arr, v) => {
            const out = [...arr, v == null ? null : Number(v)];
            return out.length > HISTORY_LEN ? out.slice(-HISTORY_LEN) : out;
        };
        historyRef.current = {
            cpu: push(historyRef.current.cpu, sample.cpu?.usage),
            mem: push(historyRef.current.mem, sample.memory?.usage),
            disk: push(historyRef.current.disk, sample.disk?.root?.usage),
        };
        setTick((n) => n + 1);
    }, [deviceId, sample]);

    return historyRef.current;
}

// journalctl --output=short: `Mon DD HH:MM:SS host unit[pid]: message`
const JOURNAL_RE = /^(\w{3}\s+\d+\s+(\d{2}:\d{2}:\d{2}))\s+\S+\s+([^:]+):\s?(.*)$/;

function parseLine(text) {
    const m = text.match(JOURNAL_RE);
    if (!m) return { time: null, unit: null, msg: text };
    const unit = m[3].replace(/\[\d+\]$/, '');
    return { time: m[2], unit, msg: m[4] };
}

function fmtBytes(n) {
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

function fmtUp(secs) {
    if (secs == null) return '—';
    const s = Math.floor(secs);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
}

function MetricRow({ label, value, history, color }) {
    const display = value == null ? '—' : `${Math.round(value)}%`;
    return (
        <Box>
            <Box width={5}>
                <Text color={theme.fgDim}>{label}</Text>
            </Box>
            <Bar value={value ?? 0} width={18} color={colorForPct(value)} />
            <Box marginLeft={1}>
                <Sparkline series={history} width={14} color={color} />
            </Box>
            <Box width={6} justifyContent="flex-end">
                <Text color={theme.fg}>{display}</Text>
            </Box>
        </Box>
    );
}

function KvRow({ k, children }) {
    return (
        <Box>
            <Box width={11}>
                <Text color={theme.fgDim}>{k}</Text>
            </Box>
            <Box flexGrow={1}>
                <Text color={theme.fg} wrap="truncate-end">
                    {children}
                </Text>
            </Box>
        </Box>
    );
}

function ActionBtn({ k, label, disabled }) {
    const color = disabled ? theme.fgFaint : theme.fg;
    return (
        <Box marginRight={2}>
            <Text>
                <Text color={disabled ? theme.fgFaint : theme.magenta}>{k}</Text>{' '}
                <Text color={color}>{label}</Text>
            </Text>
        </Box>
    );
}

function dotForHealth(h) {
    if (h === 'on') return { glyph: '●', color: theme.lime };
    if (h === 'warn') return { glyph: '▲', color: theme.amber };
    if (h === 'bad') return { glyph: '✕', color: theme.red };
    return { glyph: '○', color: theme.fgFaint };
}

export function DeviceDetailPanel({
    device,
    sample,
    paused,
    clearToken,
    focused,
}) {
    const id = device?.device || null;
    const online = !!device?.connection?.active;
    const latest = sample || null;
    const history = useDeviceHistory(id, sample);
    const monError = null;
    const { lines, status: logStatus, error: logError, clear } = useLogs({
        deviceId: id,
        online,
        paused,
    });
    const { stdout } = useStdout();

    useEffect(() => {
        if (clearToken > 0) clear();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clearToken]);

    const health = deviceHealth(device, latest);
    const dot = dotForHealth(health);
    const memUsed =
        latest?.memory?.total != null && latest?.memory?.available != null
            ? latest.memory.total - latest.memory.available
            : null;
    const memDetail =
        memUsed != null && latest?.memory?.total != null
            ? `${fmtBytes(memUsed)} / ${fmtBytes(latest.memory.total)}`
            : null;
    const diskDetail =
        latest?.disk?.root?.available != null && latest?.disk?.root?.total != null
            ? `${fmtBytes(latest.disk.root.total - latest.disk.root.available)} / ${fmtBytes(latest.disk.root.total)}`
            : null;
    const load = latest?.load
        ? [latest.load['1m'], latest.load['5m'], latest.load['15m']]
              .map((v) => (v != null ? v.toFixed(2) : '—'))
              .join(' · ')
        : null;

    const ip = device?.connection?.ip_address || null;
    const proto = device?.connection?.protocol || null;
    const agentV = normalizeAgentVersion(latest?.agent?.version) || '—';
    const cores = latest?.cpu?.cores;
    const temp = latest?.cpu?.temperature;

    // Logs visible rows: panel inside detail uses ~5 rows of chrome
    // (border + title + actions + kvlist + spacing). Reserve the rest.
    const logHeight = Math.max(4, Math.floor((stdout?.rows || 40) - 30));
    const visibleLogs = lines.slice(-logHeight);

    const logStatusLabel = (() => {
        if (!id) return { text: 'select a device', color: theme.fgDim };
        if (!online) return { text: 'device offline', color: theme.fgDim };
        if (logError) return { text: logError, color: theme.red };
        if (paused) return { text: 'paused', color: theme.amber };
        if (logStatus === 'connecting') return { text: 'connecting…', color: theme.fgDim };
        if (logStatus === 'streaming') return { text: 'live', color: theme.lime };
        if (logStatus === 'ended') return { text: 'ended', color: theme.fgDim };
        return { text: logStatus, color: theme.fgDim };
    })();

    if (!device) {
        return (
            <Panel title="DEVICE" focused={focused}>
                <Text color={theme.fgFaint}>select a device on the left</Text>
            </Panel>
        );
    }

    return (
        <Panel
            title="DEVICE"
            sub={device.device}
            focused={focused}
            right={
                <Text>
                    {proto && <Text color={theme.fgDim}>{proto} </Text>}
                    {ip && <Text color={theme.fg}>{ip}</Text>}
                </Text>
            }
        >
            {/* Header line */}
            <Box marginBottom={1}>
                <Text color={dot.color}>{dot.glyph} </Text>
                <Text color={theme.fg} bold>
                    {device.device}
                </Text>
                {device.name && (
                    <Text color={theme.fgDim}>  {device.name}</Text>
                )}
            </Box>

            {/* Metrics */}
            <MetricRow
                label="CPU"
                value={latest?.cpu?.usage}
                history={history.cpu}
                color={theme.accent}
            />
            <MetricRow
                label="MEM"
                value={latest?.memory?.usage}
                history={history.mem}
                color={theme.magenta}
            />
            <MetricRow
                label="DISK"
                value={latest?.disk?.root?.usage}
                history={history.disk}
                color={theme.lime}
            />

            {monError && !latest && (
                <Box marginTop={1}>
                    <Text color={theme.red}>{monError}</Text>
                </Box>
            )}
            {!latest && online && !monError && (
                <Box marginTop={1}>
                    <Text color={theme.fgDim}>waiting for monitoring sample…</Text>
                </Box>
            )}

            {/* Key/value */}
            <Box marginTop={1} flexDirection="column">
                <KvRow k="agent">{agentV}</KvRow>
                <KvRow k="uptime">{fmtUp(latest?.uptime)}</KvRow>
                {load && <KvRow k="load">{load}</KvRow>}
                {memDetail && <KvRow k="memory">{memDetail}</KvRow>}
                {diskDetail && <KvRow k="disk">{diskDetail}</KvRow>}
                {(cores != null || temp != null) && (
                    <KvRow k="cpu">
                        {cores != null ? `${cores} cores` : ''}
                        {cores != null && temp != null ? ' · ' : ''}
                        {temp != null ? `${temp.toFixed(1)}°C` : ''}
                    </KvRow>
                )}
            </Box>

            {/* Quick actions */}
            <Box marginTop={1}>
                <ActionBtn k="enter" label="ssh" disabled={!online} />
                <ActionBtn k="p" label="pause logs" />
                <ActionBtn k="c" label="clear logs" />
                <ActionBtn k="r" label="redeploy" disabled />
                <ActionBtn k="x" label="reboot" disabled />
            </Box>

            {/* Logs */}
            <Box marginTop={1} justifyContent="space-between">
                <Box>
                    <Text color={theme.fgDim}>journal </Text>
                    <Text color={theme.fgFaint}>tail · {device.device}</Text>
                </Box>
                <Text color={logStatusLabel.color}>● {logStatusLabel.text}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} marginTop={0}>
                {visibleLogs.length === 0 && online && !logError && (
                    <Text color={theme.fgFaint}>waiting for log stream…</Text>
                )}
                {visibleLogs.map((ln, i) => {
                    const { time, unit, msg } = parseLine(ln.text);
                    const msgColor = ln.stream === 'err' ? theme.red : theme.fg;
                    return (
                        <Box key={`${lines.length - visibleLogs.length + i}`}>
                            <Text wrap="truncate-end">
                                {time && <Text color={theme.fgFaint}>{time} </Text>}
                                {unit && <Text color={theme.magenta}>{unit} </Text>}
                                <Text color={msgColor}>{msg || ' '}</Text>
                            </Text>
                        </Box>
                    );
                })}
            </Box>
        </Panel>
    );
}
