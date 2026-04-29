import React, { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { useModal } from '../lib/focus.js';

const PAGE = 12;

const HINT = [
    { k: '↑↓', label: 'move' },
    { k: 'enter', label: 'pick' },
    { k: 'esc', label: 'cancel' },
];

export function ProfilePickerModal({ profiles, active, onSelect, onCancel }) {
    const sorted = useMemo(() => [...(profiles || [])].sort(), [profiles]);
    const initialCursor = useMemo(() => {
        const i = sorted.indexOf(active);
        return i >= 0 ? i : 0;
    }, [sorted, active]);
    const [cursor, setCursor] = useState(initialCursor);

    const effectiveCursor = Math.min(cursor, Math.max(0, sorted.length - 1));
    const viewStart = Math.max(
        0,
        Math.min(effectiveCursor - Math.floor(PAGE / 2), Math.max(0, sorted.length - PAGE)),
    );
    const viewSlice = sorted.slice(viewStart, viewStart + PAGE);

    useModal(
        (input, key) => {
            if (key.escape) {
                onCancel?.();
                return;
            }
            if (key.return) {
                const pick = sorted[effectiveCursor];
                if (pick && pick !== active) onSelect?.(pick);
                else onCancel?.();
                return;
            }
            if (key.upArrow) {
                setCursor((c) => Math.max(0, c - 1));
                return;
            }
            if (key.downArrow) {
                setCursor((c) => Math.min(sorted.length - 1, c + 1));
            }
        },
        { hint: HINT },
    );

    return (
        <Box
            borderStyle="round"
            borderColor={theme.borderFocus}
            backgroundColor={theme.overlayBg}
            paddingX={2}
            paddingY={1}
            flexDirection="column"
            width={56}
        >
            <Box marginBottom={1} justifyContent="space-between">
                <Text color={theme.accent} bold>
                    SWITCH PROFILE
                </Text>
                <Text color={theme.fgDim}>{sorted.length}</Text>
            </Box>

            {sorted.length === 0 && <Text color={theme.fgFaint}>no profiles</Text>}
            {viewSlice.map((name, i) => {
                const absIdx = viewStart + i;
                const isFocused = absIdx === effectiveCursor;
                const isActive = name === active;
                return (
                    <Box key={name}>
                        <Box width={2}>
                            <Text color={isFocused ? theme.accent : theme.fgFaint}>
                                {isFocused ? '▶' : ' '}
                            </Text>
                        </Box>
                        <Box width={2}>
                            <Text color={isActive ? theme.lime : theme.fgFaint}>
                                {isActive ? '●' : '○'}
                            </Text>
                        </Box>
                        <Box flexGrow={1}>
                            <Text
                                color={isFocused ? theme.fg : theme.fgDim}
                                bold={isFocused}
                                wrap="truncate-end"
                            >
                                {name}
                                {isActive ? '  (active)' : ''}
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
