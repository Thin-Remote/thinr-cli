import React, { useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../theme.js';
import { useLogs } from '../hooks/useLogs.js';

// journalctl --output=short: `Mon DD HH:MM:SS host unit[pid]: message`
const JOURNAL_RE = /^(\w{3}\s+\d+\s+(\d{2}:\d{2}:\d{2}))\s+\S+\s+([^:]+):\s?(.*)$/;

function parseLine(text) {
    const m = text.match(JOURNAL_RE);
    if (!m) return { time: null, unit: null, msg: text };
    const unit = m[3].replace(/\[\d+\]$/, '');
    return { time: m[2], unit, msg: m[4] };
}

export function LogsPanel({ deviceId, online, focused, paused = false, clearToken = 0 }) {
    const { lines, status, error, clear } = useLogs({ deviceId, online, paused });
    const { stdout } = useStdout();

    useEffect(() => {
        if (clearToken > 0) clear();
        // clear intentionally excluded: identity changes on every render would
        // wipe the buffer on unrelated updates.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clearToken]);

    const borderColor = focused ? theme.borderFocus : theme.border;

    // Reserve: 2 border rows + 1 title row + 1 status row = 4. Rest of terminal
    // is split: header ~3, footer ~3, monitoring ~13. LOGS gets the remainder.
    const approxPanelRows = Math.max(6, Math.floor(((stdout?.rows || 40) - 19)));
    const visible = Math.max(3, approxPanelRows - 4);
    const shown = lines.slice(-visible);

    const statusLabel = (() => {
        if (!deviceId) return { text: 'select a device', color: theme.dim };
        if (!online) return { text: 'device offline', color: theme.dim };
        if (error) return { text: error, color: theme.err };
        if (paused) return { text: 'paused', color: theme.warn };
        if (status === 'connecting') return { text: 'connecting…', color: theme.muted };
        if (status === 'streaming') return { text: 'streaming', color: theme.ok };
        if (status === 'ended') return { text: 'ended', color: theme.muted };
        return { text: status, color: theme.muted };
    })();

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={borderColor}
            paddingX={1}
            flexGrow={2}
        >
            <Box marginBottom={1} justifyContent="space-between">
                <Box>
                    <Text color={theme.muted}>LOGS</Text>
                    {deviceId && (
                        <Text color={theme.dim}>
                            {' '}
                            · <Text color={theme.fg}>{deviceId}</Text>
                        </Text>
                    )}
                </Box>
                <Text color={statusLabel.color}>● {statusLabel.text}</Text>
            </Box>

            <Box flexDirection="column" flexGrow={1}>
                {shown.length === 0 && online && deviceId && !error && (
                    <Text color={theme.dim}>waiting for lines…</Text>
                )}
                {shown.map((ln, i) => {
                    const key = `${lines.length - shown.length + i}`;
                    const { time, unit, msg } = parseLine(ln.text);
                    const msgColor = ln.stream === 'err' ? theme.err : theme.fg;
                    return (
                        <Box key={key}>
                            <Text wrap="truncate-end">
                                {time && <Text color={theme.dim}>{time} </Text>}
                                {unit && <Text color={theme.muted}>{unit} </Text>}
                                <Text color={msgColor}>{msg || ' '}</Text>
                            </Text>
                        </Box>
                    );
                })}
            </Box>
        </Box>
    );
}
