import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { Panel } from './Panel.jsx';

function StepLine({ step }) {
    const status = step.status;
    let glyph = '·';
    let color = theme.fgDim;
    if (status === 'running') {
        glyph = '↻';
        color = theme.accent;
    } else if (status === 'ok') {
        glyph = '✓';
        color = theme.lime;
    } else if (status === 'failed') {
        glyph = '✕';
        color = theme.red;
    }
    const durationTxt =
        Number.isFinite(step.durationMs) && step.status !== 'running'
            ? ` (${step.durationMs}ms)`
            : '';
    return (
        <Box>
            <Box width={2}>
                <Text color={color}>{glyph}</Text>
            </Box>
            <Box width={3}>
                <Text color={theme.fgFaint}>{String(step.index + 1).padStart(2)}.</Text>
            </Box>
            <Box flexGrow={1}>
                <Text color={theme.fg} wrap="truncate-end">
                    {step.name}
                </Text>
            </Box>
            <Box>
                <Text color={theme.fgDim} wrap="truncate-end">
                    {step.summary || ''}
                    {durationTxt}
                </Text>
            </Box>
        </Box>
    );
}

function SingleRunBody({ state }) {
    const steps = state.phase === 'done'
        ? (state.result?.steps || []).map((s) => ({
              index: s.index,
              name: s.name,
              status: s.skipped ? 'skipped' : s.ok ? 'ok' : 'failed',
              summary: s.summary,
              durationMs: s.durationMs,
          }))
        : Array.from(state.stepsProgress?.values?.() || []).sort((a, b) => a.index - b.index);

    const header = state.phase === 'running' ? 'RUNNING' : state.result?.ok ? 'DONE · OK' : 'DONE · FAILED';
    const headerColor =
        state.phase === 'running'
            ? theme.accent
            : state.result?.ok
              ? theme.lime
              : theme.red;

    return (
        <Box flexDirection="column">
            <Box justifyContent="space-between" marginBottom={1}>
                <Text color={headerColor} bold>
                    {header}
                </Text>
                <Text color={theme.fgDim}>
                    {state.playbook?.name} → {state.device?.device}
                </Text>
            </Box>
            {steps.length === 0 && <Text color={theme.fgFaint}>preparing...</Text>}
            {steps.map((s) => <StepLine key={s.index} step={s} />)}
            {state.phase === 'done' && !state.result?.ok && state.result?.error && (
                <Box marginTop={1}>
                    <Text color={theme.red}>{state.result.error}</Text>
                </Box>
            )}
        </Box>
    );
}

function FleetRunBody({ state }) {
    const summary = state.summary || { attempted: 0, succeeded: 0, failed: 0, failureRate: 0 };
    const perDevice = Array.from(state.perDevice?.values?.() || []);
    const done = state.phase === 'done';
    const title = done
        ? state.aborted
            ? 'ROLLOUT ABORTED'
            : 'ROLLOUT DONE'
        : 'ROLLING OUT';
    const headerColor = done
        ? state.aborted
            ? theme.red
            : summary.failed > 0
              ? theme.amber
              : theme.lime
        : theme.accent;

    return (
        <Box flexDirection="column">
            <Box justifyContent="space-between" marginBottom={1}>
                <Text color={headerColor} bold>
                    {title}
                </Text>
                <Text color={theme.fgDim}>
                    {state.playbook?.name} · batch {state.batchSize}
                </Text>
            </Box>
            <Box>
                <Text color={theme.fgDim}>progress: </Text>
                <Text color={theme.fg}>
                    {summary.succeeded}/{summary.attempted}
                </Text>
                <Text color={theme.fgDim}> of </Text>
                <Text color={theme.fg}>{state.totalDevices || state.deviceCount}</Text>
                <Text color={theme.fgDim}>  failure </Text>
                <Text color={summary.failureRate > 0 ? theme.red : theme.fgDim}>
                    {summary.failureRate.toFixed(1)}%
                </Text>
            </Box>
            {state.currentBatch && !done && (
                <Box>
                    <Text color={theme.fgDim}>batch {state.currentBatch.index + 1}: </Text>
                    <Text color={theme.fg}>{state.currentBatch.deviceIds?.length} device(s)</Text>
                    <Text color={theme.fgFaint}>
                        {' '}
                        [{state.currentBatch.firstIndex + 1}–
                        {state.currentBatch.firstIndex +
                            (state.currentBatch.deviceIds?.length || 0)}]
                    </Text>
                </Box>
            )}
            {(state.batches || []).length > 0 && (
                <Box marginTop={1} flexDirection="column">
                    <Text color={theme.fgDim}>batches:</Text>
                    {state.batches.map((b) => (
                        <Box key={b.index}>
                            <Box width={3}>
                                <Text color={theme.fgFaint}>{b.index + 1}.</Text>
                            </Box>
                            <Text color={theme.lime}>{b.ok || b.succeeded || 0} ok</Text>
                            <Text color={theme.fgFaint}>, </Text>
                            <Text color={(b.failed || 0) > 0 ? theme.red : theme.fgFaint}>
                                {b.failed || 0} failed
                            </Text>
                            <Text color={theme.fgFaint}>  ({b.size} device(s))</Text>
                        </Box>
                    ))}
                </Box>
            )}
            {perDevice.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                    <Text color={theme.fgDim}>devices:</Text>
                    {perDevice.slice(-10).map((r) => (
                        <Box key={r.device}>
                            <Box width={2}>
                                <Text
                                    color={
                                        r.skipped
                                            ? theme.amber
                                            : r.ok
                                              ? theme.lime
                                              : theme.red
                                    }
                                >
                                    {r.skipped ? '!' : r.ok ? '✓' : '✕'}
                                </Text>
                            </Box>
                            <Box flexGrow={1}>
                                <Text color={theme.fg} wrap="truncate-end">
                                    {r.device}
                                </Text>
                            </Box>
                            {r.error && (
                                <Text color={theme.red} wrap="truncate-end">
                                    {r.error}
                                </Text>
                            )}
                        </Box>
                    ))}
                </Box>
            )}
            {done && state.reportUpload && (
                <Box marginTop={1}>
                    {state.reportUpload.ok ? (
                        <Text color={theme.fgDim}>report: {state.reportUpload.path}</Text>
                    ) : (
                        <Text color={theme.amber}>
                            report not saved: {state.reportUpload.reason}
                        </Text>
                    )}
                </Box>
            )}
        </Box>
    );
}

export function PlaybookRunView({ state }) {
    if (!state || state.phase === 'idle') {
        return (
            <Panel title="RUN" flexGrow={1}>
                <Text color={theme.fgFaint}>(no run in progress)</Text>
            </Panel>
        );
    }
    const running = state.phase === 'running';
    const title = state.mode === 'fleet' ? 'ROLLOUT' : 'RUN';
    const right = running ? (
        <Text color={theme.accent}>● running · esc abort</Text>
    ) : (
        <Text color={theme.fgDim}>esc close</Text>
    );
    return (
        <Panel title={title} right={right} flexGrow={1}>
            {state.mode === 'fleet' ? (
                <FleetRunBody state={state} />
            ) : (
                <SingleRunBody state={state} />
            )}
        </Panel>
    );
}
