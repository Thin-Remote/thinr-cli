import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export function Header({ total, online, server }) {
    return (
        <Box
            borderStyle="round"
            borderColor={theme.border}
            paddingX={1}
            justifyContent="space-between"
        >
            <Box>
                <Text color={theme.accent} bold>
                    thinr
                </Text>
                <Text color={theme.muted}> · dashboard</Text>
            </Box>
            <Box>
                <Text color={theme.muted}>
                    {server ? `${server}  ` : ''}
                    <Text color={theme.ok}>{online}</Text>
                    <Text color={theme.muted}> / {total} online</Text>
                </Text>
            </Box>
        </Box>
    );
}
