import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';

const MIN_BATCH = 1;
const MAX_BATCH = 20;

export function UpgradeModal({ outdatedCount, target, onConfirm, onCancel }) {
    const [canary, setCanary] = useState(true);
    const [abortOnFailure, setAbortOnFailure] = useState(true);
    const [batchSize, setBatchSize] = useState(5);

    useInput((input, key) => {
        if (key.escape) {
            onCancel?.();
            return;
        }
        if (key.return) {
            onConfirm?.({ canary, abortOnFailure, batchSize });
            return;
        }
        if (input === 'c') setCanary((v) => !v);
        else if (input === 'f') setAbortOnFailure((v) => !v);
        else if (input === '+' || input === '=')
            setBatchSize((n) => Math.min(MAX_BATCH, n + 1));
        else if (input === '-' || input === '_')
            setBatchSize((n) => Math.max(MIN_BATCH, n - 1));
    });

    const check = (on) => (on ? <Text color={theme.lime}>[x]</Text> : <Text color={theme.fgDim}>[ ]</Text>);

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
                <Text color={theme.accent} bold>
                    UPGRADE {outdatedCount} DEVICE{outdatedCount === 1 ? '' : 'S'}
                </Text>
                <Text color={theme.fgDim}> · target </Text>
                <Text color={theme.lime}>{target || 'latest'}</Text>
            </Box>

            <Box>
                {check(canary)}
                <Text color={theme.fg}> canary first </Text>
                <Text color={theme.fgFaint}>(c)</Text>
            </Box>
            <Box>
                {check(abortOnFailure)}
                <Text color={theme.fg}> abort on failure </Text>
                <Text color={theme.fgFaint}>(f)</Text>
            </Box>
            <Box>
                <Text color={theme.fgDim}>    batch size: </Text>
                <Text color={theme.accent} bold>{batchSize}</Text>
                <Text color={theme.fgFaint}> (+/-)</Text>
            </Box>

            <Box marginTop={1}>
                <Text color={theme.fgDim}>enter </Text>
                <Text color={theme.lime}>start</Text>
                <Text color={theme.fgDim}>   ·   esc </Text>
                <Text color={theme.amber}>cancel</Text>
            </Box>
        </Box>
    );
}
