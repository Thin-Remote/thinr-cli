import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

const TABS = [
    { id: 'overview', label: 'overview', key: '1' },
    { id: 'devices', label: 'devices', key: '2' },
    { id: 'alerts', label: 'alerts', key: '3' },
    { id: 'events', label: 'events', key: '4' },
];

function Tab({ label, keyHint, active }) {
    if (active) {
        return (
            <Text backgroundColor={theme.accent} color="#0a0b10" bold>
                {' '}
                {keyHint} {label}{' '}
            </Text>
        );
    }
    return (
        <Text>
            <Text color={theme.magenta}>{keyHint}</Text>
            <Text color={theme.fgDim}> {label}</Text>
        </Text>
    );
}

export function Header({ tab, onTab, counts, server }) {
    const { total = 0, online = 0, warn = 0, bad = 0 } = counts || {};
    return (
        <Box
            borderStyle="round"
            borderColor={theme.border}
            paddingX={1}
            justifyContent="space-between"
        >
            <Box gap={2}>
                <Text color={theme.accent} bold>
                    thinr
                </Text>
                {TABS.map((t, i) => (
                    <React.Fragment key={t.id}>
                        {i === 0 && <Text color={theme.border}>│</Text>}
                        <Tab label={t.label} keyHint={t.key} active={tab === t.id} />
                    </React.Fragment>
                ))}
            </Box>
            <Box gap={2}>
                {server && <Text color={theme.fgDim}>{server}</Text>}
                <Text>
                    <Text color={theme.lime} bold>
                        {online}
                    </Text>
                    <Text color={theme.fgDim}> / {total} online</Text>
                </Text>
                {warn > 0 && (
                    <Text>
                        <Text color={theme.amber} bold>
                            {warn}
                        </Text>
                        <Text color={theme.fgDim}> warn</Text>
                    </Text>
                )}
                {bad > 0 && (
                    <Text>
                        <Text color={theme.red} bold>
                            {bad}
                        </Text>
                        <Text color={theme.fgDim}> crit</Text>
                    </Text>
                )}
            </Box>
        </Box>
    );
}

export { TABS };
