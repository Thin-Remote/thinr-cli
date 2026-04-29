import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../theme.js';
import { Panel } from './Panel.jsx';
import { Sparkline, Bar, colorForPct } from './Sparkline.jsx';
import { useLogs } from '../hooks/useLogs.js';
import { deviceHealth, normalizeAgentVersion } from '../lib/status.js';
import {
    levelPassesThreshold,
    parseLogLine,
} from '../../../lib/product/log-presets.js';

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

// Color mapping for parsed log levels. Keys are normalized (lowercase).
// Anything outside this table falls back to `theme.fg` so unknown levels
// from a custom pattern stay readable instead of disappearing.
const LEVEL_STYLE = {
    trace: { color: theme.fgDim, bold: false },
    debug: { color: theme.fgDim, bold: false },
    info: { color: theme.fg, bold: false },
    notice: { color: theme.accent, bold: false },
    warn: { color: theme.amber, bold: false },
    warning: { color: theme.amber, bold: false },
    error: { color: theme.red, bold: false },
    crit: { color: theme.red, bold: true },
    critical: { color: theme.red, bold: true },
    fatal: { color: theme.red, bold: true },
};

const LEVEL_PAD = 5;
function padLevel(s) {
    if (s.length >= LEVEL_PAD) return s.slice(0, LEVEL_PAD);
    return s + ' '.repeat(LEVEL_PAD - s.length);
}

const FILTER_LABEL = {
    all: null,
    info: 'level ≥ info',
    warn: 'level ≥ warn',
    error: 'level ≥ error',
};

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

// Render a single log line. When `parsed` is non-null the line is split
// into time / level / msg with theme-aware colours; otherwise the raw
// text is shown so we never silently drop lines that didn't match the
// pattern (multi-line stack traces, banners, etc.).
function LogLineRow({ text, parsed }) {
    if (!parsed) {
        return (
            <Box>
                <Text color={theme.fg} wrap="truncate-end">
                    {text || ' '}
                </Text>
            </Box>
        );
    }
    const { time, level, level_norm: levelNorm, msg } = parsed;
    const style = levelNorm ? LEVEL_STYLE[levelNorm] : null;
    const levelColor = style?.color || theme.fg;
    const levelBold = !!style?.bold;
    // Critical/fatal lines also paint the message in red so the whole
    // entry stands out, not just the 5-char level slot.
    const msgRed = levelNorm === 'fatal' || levelNorm === 'critical' || levelNorm === 'crit';
    const msgColor = msgRed ? theme.red : theme.fg;
    return (
        <Box>
            <Text wrap="truncate-end">
                {time && <Text color={theme.fgFaint}>{time} </Text>}
                {level && (
                    <Text color={levelColor} bold={levelBold}>
                        {padLevel(level.toUpperCase())}{' '}
                    </Text>
                )}
                <Text color={msgColor} bold={levelBold && msgRed}>
                    {msg || ' '}
                </Text>
            </Text>
        </Box>
    );
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
    levelFilter = 'all',
    filterEnabled = false,
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
    const sourcePattern = activeSource?.resolvedPattern || null;
    // Compile the active pattern once per source change. `null` means
    // "render raw" — keeps the panel compatible with sources that
    // declare neither a pattern nor a preset.
    const compiledPattern = useMemo(() => {
        if (!sourcePattern) return null;
        try {
            return new RegExp(sourcePattern);
        } catch {
            return null;
        }
    }, [sourcePattern]);
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

    // Parse + filter once so the slice that fills the visible window
    // already accounts for hidden lines. We don't want a `warn+` filter
    // to leave the panel half-empty when most lines were `info`.
    const parsedLines = useMemo(() => {
        return lines.map((ln) => {
            const parsed = parseLogLine(ln.text, compiledPattern);
            return { line: ln, parsed };
        });
    }, [lines, compiledPattern]);
    const filteredLines = useMemo(() => {
        if (levelFilter === 'all') return parsedLines;
        return parsedLines.filter((p) =>
            levelPassesThreshold(p.parsed?.level_norm, levelFilter),
        );
    }, [parsedLines, levelFilter]);
    const visibleLogs = filteredLines.slice(-logHeight);

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
                    {filterEnabled && FILTER_LABEL[levelFilter] && (
                        <>
                            <Sep />
                            <Text color={theme.magenta}>{FILTER_LABEL[levelFilter]}</Text>
                        </>
                    )}
                    {!filterEnabled && (
                        <>
                            <Sep />
                            <Text color={theme.fgFaint}>set a pattern to filter by level</Text>
                        </>
                    )}
                </Box>
                <Text color={logStatusLabel.color}>● {logStatusLabel.text}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1}>
                {visibleLogs.length === 0 && online && !logError && (
                    <Text color={theme.fgFaint}>waiting for log stream…</Text>
                )}
                {visibleLogs.map(({ line, parsed }, i) => (
                    <LogLineRow
                        key={`${filteredLines.length - visibleLogs.length + i}`}
                        text={line.text}
                        parsed={parsed}
                    />
                ))}
            </Box>
        </Panel>
    );
}
