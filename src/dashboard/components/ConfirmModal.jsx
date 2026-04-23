import React from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';

export function ConfirmModal({ title, body, confirmLabel = 'confirm', tone = 'warn', onConfirm, onCancel }) {
    useInput((input, key) => {
        if (key.escape) {
            onCancel?.();
            return;
        }
        if (key.return || input === 'y' || input === 'Y') {
            onConfirm?.();
            return;
        }
        if (input === 'n' || input === 'N') {
            onCancel?.();
        }
    });

    const accentColor = tone === 'danger' ? theme.red : tone === 'ok' ? theme.lime : theme.amber;

    return (
        <Box
            borderStyle="round"
            borderColor={theme.borderFocus}
            backgroundColor={theme.overlayBg}
            paddingX={2}
            paddingY={1}
            flexDirection="column"
            width={60}
        >
            <Box marginBottom={1}>
                <Text color={accentColor} bold>
                    {title}
                </Text>
            </Box>
            {body &&
                (Array.isArray(body) ? body : [body]).map((line, i) => (
                    <Box key={i}>
                        <Text color={theme.fg}>{line}</Text>
                    </Box>
                ))}
            <Box marginTop={1} justifyContent="space-between">
                <Text color={accentColor} bold>
                    enter/y {confirmLabel}
                </Text>
                <Text color={theme.fgDim}>esc/n cancel</Text>
            </Box>
        </Box>
    );
}
