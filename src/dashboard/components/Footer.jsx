import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

function Key({ k, label }) {
    return (
        <Text>
            <Text color={theme.magenta}>{k}</Text>
            <Text color={theme.fgDim}> {label}</Text>
        </Text>
    );
}

export function Footer({ hints, right }) {
    return (
        <Box borderStyle="single" borderColor={theme.border} paddingX={1} justifyContent="space-between">
            <Box gap={2}>
                {hints.map((h, i) => (
                    <Key key={i} k={h.k} label={h.label} />
                ))}
            </Box>
            {right && <Text color={theme.fgFaint}>{right}</Text>}
        </Box>
    );
}
