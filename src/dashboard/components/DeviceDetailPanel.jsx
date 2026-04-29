import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../theme.js';
import { Panel } from './Panel.jsx';
import { Sparkline, Bar, colorForPct } from './Sparkline.jsx';
import { useLogs } from '../hooks/useLogs.js';
import { deviceHealth, normalizeAgentVersion } from '../lib/status.js';

const HISTORY_LEN = 40;

function useDeviceHistory(deviceId, sample) {
    const historyRef = useRef({ cpu: [], mem: [], swap: [], disk: [] });
    const lastDeviceRef = useRef(null);
    const [, setTick] = useState(0);

    useEffect(() => {
        if (lastDeviceRef.current !== deviceId) {
            historyRef.current = { cpu: [], mem: [], swap: [], disk: [] };
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
            swap: push(historyRef.current.swap, sample.memory?.swap?.usage),
            disk: push(historyRef.current.disk, sample.disk?.root?.usage),
        };
        setTick((n) => n + 1);
    }, [deviceId, sample]);

    return historyRef.current;
}

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

function MetricRow({ label, value, color, history, detail }) {
    const valueColor = colorForPct(value);
    const valueText = value == null ? '  —' : `${Math.round(value).toString().padStart(3)}%`;
    return (
        <Box>
            <Box width={6}>
                <Text color={theme.fgFaint} bold>
                    {label}
                </Text>
            </Box>
            <Box width={5} justifyContent="flex-end" marginRight={1}>
                <Text color={valueColor} bold>
                    {valueText}
                </Text>
            </Box>
            <Bar value={value ?? 0} width={28} color={valueColor} />
            <Box marginLeft={1}>
                <Sparkline series={history} width={20} color={color} />
            </Box>
            <Box marginLeft={2} flexGrow={1}>
                <Text color={theme.fgDim} wrap="truncate-end">
                    {detail || ''}
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

function Sep() {
    return <Text color={theme.fgFaint}>{'  ·  '}</Text>;
}

export function DeviceDetailPanel({
    device,
    sample,
    alarmSeverity,
    paused,
    clearToken,
    focused,
    logSources,
    activeSource,
    activeSourceIndex,
}) {
    const id = device?.device || null;
    const online = !!device?.connection?.active;
    const latest = sample || null;
    const history = useDeviceHistory(id, sample);
    const monError = null;
    const sources = logSources?.sources || [];
    const sourceCount = sources.length;
    const sourceName = activeSource?.name || null;
    const sourceCommand = activeSource?.command || null;
    const { lines, status: logStatus, error: logError, clear } = useLogs({
        deviceId: id,
        online,
        paused,
        command: sourceCommand,
    });
    const { stdout } = useStdout();

    useEffect(() => {
        if (clearToken > 0) clear();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clearToken]);

    const health = deviceHealth(device, alarmSeverity);
    const dot = dotForHealth(health);
    const memUsed =
        latest?.memory?.total != null && latest?.memory?.available != null
            ? latest.memory.total - latest.memory.available
            : null;
    const memDetail =
        memUsed != null && latest?.memory?.total != null
            ? `${fmtBytes(memUsed)} / ${fmtBytes(latest.memory.total)}`
            : null;
    const swap = latest?.memory?.swap;
    const hasSwap = swap && swap.total != null && swap.total > 0;
    const swapDetail = hasSwap
        ? `${fmtBytes(swap.total - (swap.free ?? 0))} / ${fmtBytes(swap.total)}`
        : null;
    const diskDetail =
        latest?.disk?.root?.available != null && latest?.disk?.root?.total != null
            ? `${fmtBytes(latest.disk.root.total - latest.disk.root.available)} / ${fmtBytes(latest.disk.root.total)}`
            : null;
    const load = latest?.load
        ? [latest.load['1m'], latest.load['5m'], latest.load['15m']]
              .map((v) => (v != null ? v.toFixed(2) : '—'))
              .join(' / ')
        : null;

    const ip = device?.connection?.ip_address || null;
    const proto = device?.connection?.protocol || null;
    const agentV = normalizeAgentVersion(latest?.agent?.version) || '—';
    const temp = latest?.cpu?.temperature;
    // Chrome inside the panel: title (1) + identity (1) + meta+gap (2) +
    // metrics rows (3 or 4 if swap) + actions+gap (2) + journal header+gap (2) +
    // panel borders (2). Plus dashboard header+footer (2). Total ≈ 15 (+1 swap).
    const chromeReserve = 15 + (hasSwap ? 1 : 0);
    const logHeight = Math.max(4, (stdout?.rows || 40) - chromeReserve);
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

    const friendlyName = device.name || ip || null;

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
            {/* Identity line */}
            <Box>
                <Text color={dot.color}>{dot.glyph} </Text>
                <Text color={online ? theme.fg : theme.fgDim} bold>
                    {device.device}
                </Text>
                {friendlyName && (
                    <>
                        <Sep />
                        <Text color={theme.fgDim}>{friendlyName}</Text>
                    </>
                )}
            </Box>

            {/* Meta line */}
            <Box marginBottom={1}>
                <Text color={theme.fgFaint}>agent </Text>
                <Text color={theme.fg}>{agentV}</Text>
                <Sep />
                <Text color={theme.fgFaint}>up </Text>
                <Text color={theme.fg}>{fmtUp(latest?.uptime)}</Text>
                {load && (
                    <>
                        <Sep />
                        <Text color={theme.fgFaint}>load </Text>
                        <Text color={theme.fg}>{load}</Text>
                    </>
                )}
            </Box>

            {/* Metrics, one row each, aligned in columns */}
            <Box flexDirection="column">
                <MetricRow
                    label="CPU"
                    value={latest?.cpu?.usage}
                    history={history.cpu}
                    color={theme.accent}
                    detail={
                        latest?.cpu?.cores != null
                            ? `${latest.cpu.cores} core${latest.cpu.cores === 1 ? '' : 's'}${temp != null ? ` · ${temp.toFixed(1)}°C` : ''}`
                            : ''
                    }
                />
                <MetricRow
                    label="MEM"
                    value={latest?.memory?.usage}
                    history={history.mem}
                    color={theme.magenta}
                    detail={memDetail || ''}
                />
                {hasSwap && (
                    <MetricRow
                        label="SWAP"
                        value={swap.usage}
                        history={history.swap}
                        color={theme.amber}
                        detail={swapDetail || ''}
                    />
                )}
                <MetricRow
                    label="DISK"
                    value={latest?.disk?.root?.usage}
                    history={history.disk}
                    color={theme.lime}
                    detail={diskDetail || ''}
                />
            </Box>

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
                    <Text color={theme.fgDim}>{sourceName || 'logs'} </Text>
                    <Text color={theme.fgFaint}>tail · {device.device}</Text>
                    {sourceCount > 1 && activeSourceIndex >= 0 && (
                        <>
                            <Sep />
                            <Text color={theme.fgFaint}>
                                {activeSourceIndex + 1}/{sourceCount}{' '}
                            </Text>
                            <Text color={theme.magenta}>l</Text>
                        </>
                    )}
                </Box>
                <Text color={logStatusLabel.color}>● {logStatusLabel.text}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
                {visibleLogs.length === 0 && online && !logError && (
                    <Text color={theme.fgFaint}>waiting for log stream…</Text>
                )}
                {visibleLogs.map((ln, i) => {
                    const { time, unit, msg } = parseLine(ln.text);
                    // Don't paint stderr lines red: many apps (nginx, mongo,
                    // thinger) log INFO/WARN to stderr by convention, and
                    // journalctl itself flows on stdout, so the channel is
                    // not a reliable error signal across arbitrary sources.
                    const msgColor = theme.fg;
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
