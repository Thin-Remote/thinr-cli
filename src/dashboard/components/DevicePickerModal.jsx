import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';

const PAGE = 12;

export function DevicePickerModal({ title, devices, onSelect, onCancel }) {
    const sorted = useMemo(() => {
        return [...(devices || [])].sort((a, b) => {
            const ao = a.connection?.active ? 0 : 1;
            const bo = b.connection?.active ? 0 : 1;
            if (ao !== bo) return ao - bo;
            return (a.device || '').localeCompare(b.device || '');
        });
    }, [devices]);

    const [filter, setFilter] = useState('');
    const [cursor, setCursor] = useState(0);

    const filtered = useMemo(() => {
        if (!filter) return sorted;
        const q = filter.toLowerCase();
        return sorted.filter(
            (d) =>
                d.device.toLowerCase().includes(q) ||
                (d.name && d.name.toLowerCase().includes(q)),
        );
    }, [sorted, filter]);

    const effectiveCursor = Math.min(cursor, Math.max(0, filtered.length - 1));
    const viewStart = Math.max(
        0,
        Math.min(effectiveCursor - Math.floor(PAGE / 2), Math.max(0, filtered.length - PAGE)),
    );
    const viewSlice = filtered.slice(viewStart, viewStart + PAGE);

    useInput((input, key) => {
        if (key.escape) {
            onCancel?.();
            return;
        }
        if (key.return) {
            const pick = filtered[effectiveCursor];
            if (pick) onSelect?.(pick);
            return;
        }
        if (key.upArrow) {
            setCursor((c) => Math.max(0, c - 1));
            return;
        }
        if (key.downArrow) {
            setCursor((c) => Math.min(filtered.length - 1, c + 1));
            return;
        }
        if (key.backspace || key.delete) {
            setFilter((f) => f.slice(0, -1));
            setCursor(0);
            return;
        }
        if (input && !key.ctrl && !key.meta && input.length === 1 && input >= ' ') {
            setFilter((f) => f + input);
            setCursor(0);
        }
    });

    return (
        <Box
            borderStyle="round"
            borderColor={theme.borderFocus}
            backgroundColor={theme.overlayBg}
            paddingX={2}
            paddingY={1}
            flexDirection="column"
            width={64}
        >
            <Box marginBottom={1} justifyContent="space-between">
                <Text color={theme.accent} bold>
                    {title || 'PICK A DEVICE'}
                </Text>
                <Text color={theme.fgDim}>
                    {filtered.length}/{sorted.length}
                </Text>
            </Box>

            <Box marginBottom={1}>
                <Text color={theme.fgDim}>filter: </Text>
                <Text color={theme.fg}>{filter || ' '}</Text>
                <Text color={theme.accent} inverse>
                    {' '}
                </Text>
            </Box>

            {filtered.length === 0 && (
                <Text color={theme.fgFaint}>no matching devices</Text>
            )}
            {viewSlice.map((d, i) => {
                const absIdx = viewStart + i;
                const isFocused = absIdx === effectiveCursor;
                const online = !!d.connection?.active;
                return (
                    <Box key={d.device}>
                        <Box width={2}>
                            <Text color={isFocused ? theme.accent : theme.fgFaint}>
                                {isFocused ? '▶' : ' '}
                            </Text>
                        </Box>
                        <Box width={2}>
                            <Text color={online ? theme.lime : theme.fgFaint}>
                                {online ? '●' : '○'}
                            </Text>
                        </Box>
                        <Box flexGrow={1}>
                            <Text
                                color={isFocused ? theme.fg : theme.fgDim}
                                bold={isFocused}
                                wrap="truncate-end"
                            >
                                {d.device}
                                {d.name ? `  (${d.name})` : ''}
                            </Text>
                        </Box>
                    </Box>
                );
            })}

            <Box marginTop={1}>
                <Text color={theme.fgDim}>↑↓ move · enter pick · esc cancel</Text>
            </Box>
        </Box>
    );
}
