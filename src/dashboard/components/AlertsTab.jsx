import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { Panel } from './Panel.jsx';
import { activeAlerts } from '../lib/status.js';

const SEV = {
    crit: { glyph: '●', color: theme.red, label: 'CRIT' },
    warn: { glyph: '▲', color: theme.amber, label: 'WARN' },
    info: { glyph: 'i', color: theme.accent, label: 'INFO' },
};

function HeaderCell({ label, width, align = 'left' }) {
    return (
        <Box width={width} justifyContent={align === 'right' ? 'flex-end' : 'flex-start'}>
            <Text color={theme.fgFaint}>{label}</Text>
        </Box>
    );
}

function AlertRow({ a, devWidth }) {
    const sev = SEV[a.sev] || SEV.info;
    return (
        <Box>
            <Box width={8}>
                <Text color={sev.color} bold>
                    {sev.glyph} {sev.label}
                </Text>
            </Box>
            <Box width={devWidth + 2}>
                <Text color={theme.fg} wrap="truncate-end">
                    {a.dev}
                </Text>
            </Box>
            <Box flexGrow={1}>
                <Text color={theme.fgDim} wrap="truncate-end">
                    {a.msg}
                </Text>
            </Box>
        </Box>
    );
}

export function AlertsTab({ devices, samples }) {
    const alerts = useMemo(() => activeAlerts(devices, samples), [devices, samples]);
    const counts = useMemo(() => {
        let crit = 0,
            warn = 0;
        for (const a of alerts) {
            if (a.sev === 'crit') crit++;
            else if (a.sev === 'warn') warn++;
        }
        return { crit, warn };
    }, [alerts]);
    const devWidth = useMemo(
        () => alerts.reduce((w, a) => Math.max(w, a.dev.length), 12),
        [alerts],
    );

    return (
        <Box flexGrow={1}>
            <Panel
                title="ALERTS"
                sub={`${alerts.length} active`}
                right={
                    <Text>
                        <Text color={theme.red} bold>
                            {counts.crit}
                        </Text>
                        <Text color={theme.fgDim}> crit · </Text>
                        <Text color={theme.amber} bold>
                            {counts.warn}
                        </Text>
                        <Text color={theme.fgDim}> warn</Text>
                    </Text>
                }
            >
                <Box marginBottom={1}>
                    <HeaderCell label="severity" width={8} />
                    <HeaderCell label="device" width={devWidth + 2} />
                    <HeaderCell label="message" width={50} />
                </Box>
                {alerts.length === 0 && (
                    <Text color={theme.fgFaint}>
                        no active alerts — fleet is healthy
                    </Text>
                )}
                {alerts.map((a, i) => (
                    <AlertRow key={`${a.dev}-${i}`} a={a} devWidth={devWidth} />
                ))}
            </Panel>
        </Box>
    );
}
