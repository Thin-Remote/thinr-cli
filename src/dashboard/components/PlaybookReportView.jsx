import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

function fmtTs(s) {
    if (!s) return '—';
    try {
        return new Date(s).toLocaleString();
    } catch {
        return String(s);
    }
}

export function PlaybookReportView({ detail }) {
    if (!detail) return null;
    if (detail.loading) {
        return <Text color={theme.fgDim}>loading report…</Text>;
    }
    if (detail.error && !detail.report) {
        return (
            <Box flexDirection="column">
                <Text color={theme.red}>{detail.error}</Text>
                {detail.raw && (
                    <Text color={theme.fgDim} wrap="truncate-end">
                        {detail.raw.slice(0, 300)}
                    </Text>
                )}
            </Box>
        );
    }
    const r = detail.report;
    if (!r) return <Text color={theme.fgFaint}>(empty)</Text>;

    const summary = r.summary || {};
    const failed = r.aborted || (summary.failed || 0) > 0;

    return (
        <Box flexDirection="column">
            <Box justifyContent="space-between">
                <Text color={theme.accent} bold>
                    {r.name}
                </Text>
                <Text color={failed ? theme.red : theme.lime}>
                    {r.aborted ? 'ABORTED' : failed ? 'FAILED' : 'OK'}
                </Text>
            </Box>
            <Box>
                <Text color={theme.fgDim}>started: </Text>
                <Text color={theme.fg}>{fmtTs(r.startedAt)}</Text>
            </Box>
            <Box>
                <Text color={theme.fgDim}>finished: </Text>
                <Text color={theme.fg}>{fmtTs(r.finishedAt)}</Text>
            </Box>
            <Box>
                <Text color={theme.fgDim}>user: </Text>
                <Text color={theme.fg}>{r.user || '—'}</Text>
            </Box>
            <Box>
                <Text color={theme.fgDim}>mode: </Text>
                <Text color={theme.fg}>{r.mode || '—'}</Text>
                {r.rollout && (
                    <>
                        <Text color={theme.fgDim}>  batch=</Text>
                        <Text color={theme.fg}>{r.rollout.batchSize}</Text>
                        <Text color={theme.fgDim}>  threshold=</Text>
                        <Text color={theme.fg}>{r.rollout.failureThreshold}%</Text>
                    </>
                )}
            </Box>
            <Box marginTop={1}>
                <Text color={theme.fgDim}>attempted: </Text>
                <Text color={theme.fg}>{summary.attempted ?? 0}</Text>
                <Text color={theme.fgDim}>  ok: </Text>
                <Text color={theme.lime}>{summary.succeeded ?? 0}</Text>
                <Text color={theme.fgDim}>  failed: </Text>
                <Text color={(summary.failed || 0) > 0 ? theme.red : theme.fgDim}>
                    {summary.failed ?? 0}
                </Text>
                <Text color={theme.fgDim}>  rate: </Text>
                <Text color={theme.fg}>
                    {Number.isFinite(summary.failureRate)
                        ? `${summary.failureRate.toFixed(1)}%`
                        : '—'}
                </Text>
            </Box>
            {r.reason && (
                <Box>
                    <Text color={theme.fgDim}>reason: </Text>
                    <Text color={theme.amber}>{r.reason}</Text>
                </Box>
            )}
            {Array.isArray(r.devices) && r.devices.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                    <Text color={theme.fgDim}>devices:</Text>
                    {r.devices.slice(0, 20).map((d) => (
                        <Box key={d.device}>
                            <Box width={2}>
                                <Text
                                    color={
                                        d.skipped
                                            ? theme.amber
                                            : d.ok
                                              ? theme.lime
                                              : theme.red
                                    }
                                >
                                    {d.skipped ? '!' : d.ok ? '✓' : '✕'}
                                </Text>
                            </Box>
                            <Box flexGrow={1}>
                                <Text color={theme.fg} wrap="truncate-end">
                                    {d.device}
                                </Text>
                            </Box>
                            {d.error && (
                                <Text color={theme.red} wrap="truncate-end">
                                    {d.error}
                                </Text>
                            )}
                        </Box>
                    ))}
                    {r.devices.length > 20 && (
                        <Text color={theme.fgFaint}>
                            …{r.devices.length - 20} more
                        </Text>
                    )}
                </Box>
            )}
        </Box>
    );
}
