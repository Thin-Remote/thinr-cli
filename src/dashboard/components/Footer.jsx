import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

function Key({ k, label }) {
    return (
        <Text color={theme.muted}>
            <Text color={theme.accent}>{k}</Text> {label}
        </Text>
    );
}

export function Footer({ hints }) {
    return (
        <Box borderStyle="single" borderColor={theme.border} paddingX={1} gap={2}>
            {hints.map((h, i) => (
                <Key key={i} k={h.k} label={h.label} />
            ))}
        </Box>
    );
}
