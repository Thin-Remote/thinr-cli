import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { Panel } from './Panel.jsx';

const KIND = {
    join: { color: theme.lime },
    leave: { color: theme.amber },
    err: { color: theme.red },
    info: { color: theme.accent },
    deploy: { color: theme.magenta },
};

function EventRow({ e, devWidth }) {
    const k = KIND[e.kind] || KIND.info;
    return (
        <Box>
            <Box width={10}>
                <Text color={theme.fgFaint}>{e.t}</Text>
            </Box>
            <Box width={8}>
                <Text color={k.color} bold>
                    {e.kind.toUpperCase()}
                </Text>
            </Box>
            <Box width={devWidth + 2}>
                <Text color={theme.fg} wrap="truncate-end">
                    {e.dev}
                </Text>
            </Box>
            <Box flexGrow={1}>
                <Text color={theme.fgDim} wrap="truncate-end">
                    {e.msg}
                </Text>
            </Box>
        </Box>
    );
}

export function EventsTab({ events }) {
    const counts = useMemo(() => {
        const out = { join: 0, leave: 0 };
        for (const e of events) {
            if (e.kind === 'join') out.join++;
            else if (e.kind === 'leave') out.leave++;
        }
        return out;
    }, [events]);
    const devWidth = useMemo(
        () => events.reduce((w, e) => Math.max(w, e.dev.length), 12),
        [events],
    );

    return (
        <Box flexGrow={1}>
            <Panel
                title="EVENTS"
                sub={`${events.length} captured`}
                right={
                    <Text>
                        <Text color={theme.lime} bold>
                            {counts.join}
                        </Text>
                        <Text color={theme.fgDim}> joins · </Text>
                        <Text color={theme.amber} bold>
                            {counts.leave}
                        </Text>
                        <Text color={theme.fgDim}> leaves · </Text>
                        <Text color={theme.lime}>● live</Text>
                    </Text>
                }
            >
                {events.length === 0 && (
                    <Text color={theme.fgFaint}>
                        waiting for connection events… (joins/leaves derived from device polling)
                    </Text>
                )}
                {events.map((e, i) => (
                    <EventRow key={`${e.t}-${e.dev}-${i}`} e={e} devWidth={devWidth} />
                ))}
            </Panel>
        </Box>
    );
}
