import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { Panel } from './Panel.jsx';

function StepLine({ step, selected, expanded, focused }) {
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
    const marker = selected ? (focused ? '▶' : '›') : ' ';
    const expandTag = expanded ? ' ▾' : selectable(step) ? ' ▸' : '';
    return (
        <Box>
            <Box width={2}>
                <Text color={selected ? theme.accent : theme.fgFaint}>{marker}</Text>
            </Box>
            <Box width={2}>
                <Text color={color}>{glyph}</Text>
            </Box>
            <Box width={3}>
                <Text color={theme.fgFaint}>{String(step.index + 1).padStart(2)}.</Text>
            </Box>
            <Box flexGrow={1}>
                <Text color={selected ? theme.fg : theme.fg} bold={selected} wrap="truncate-end">
                    {step.name}
                    {expandTag && <Text color={theme.fgFaint}>{expandTag}</Text>}
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

function selectable(step) {
    return !!(step?.stdout || step?.stderr || step?.error);
}

function StepOutputView({ step, maxLines }) {
    if (!step) return null;
    const stdout = (step.stdout || '').replace(/\s+$/, '');
    const stderr = (step.stderr || '').replace(/\s+$/, '');
    const error = step.error;
    const nothing = !stdout && !stderr && !error;
    if (nothing) {
        return (
            <Box marginTop={1}>
                <Text color={theme.fgFaint}>(no output captured for this step)</Text>
            </Box>
        );
    }
    const budget = Math.max(4, maxLines || 12);
    const sections = [];
    if (stderr) sections.push({ label: 'stderr', color: theme.red, text: stderr });
    if (stdout) sections.push({ label: 'stdout', color: theme.fgDim, text: stdout });
    if (error && !stderr && !stdout) {
        sections.push({ label: 'error', color: theme.red, text: error });
    }
    const perSection = Math.max(2, Math.floor(budget / Math.max(1, sections.length)));
    return (
        <Box marginTop={1} flexDirection="column">
            {sections.map((s, idx) => {
                const lines = s.text.split('\n');
                const tail = lines.slice(-perSection);
                const dropped = lines.length - tail.length;
                return (
                    <Box key={idx} flexDirection="column" marginTop={idx === 0 ? 0 : 1}>
                        <Text color={s.color}>── {s.label} ──</Text>
                        {dropped > 0 && (
                            <Text color={theme.fgFaint}>
                                …{dropped} earlier line{dropped === 1 ? '' : 's'}
                            </Text>
                        )}
                        {tail.map((ln, i) => (
                            <Text key={i} color={theme.fg} wrap="wrap">
                                {ln || ' '}
                            </Text>
                        ))}
                    </Box>
                );
            })}
        </Box>
    );
}

function buildStepsForDone(state) {
    return (state.result?.steps || []).map((s) => ({
        index: s.index,
        name: s.name,
        status: s.skipped ? 'skipped' : s.ok ? 'ok' : 'failed',
        summary: s.summary,
        error: s.error,
        durationMs: s.durationMs,
        stdout: s.stdout,
        stderr: s.stderr,
        exitCode: s.exitCode,
    }));
}

function SingleRunBody({ state, focused, onClose, maxOutputLines }) {
    const steps = useMemo(() => {
        if (state.phase === 'done') return buildStepsForDone(state);
        return Array.from(state.stepsProgress?.values?.() || []).sort((a, b) => a.index - b.index);
    }, [state]);

    const isDone = state.phase === 'done';
    const firstFailedIdx = useMemo(() => {
        if (!isDone) return -1;
        return steps.findIndex((s) => s.status === 'failed');
    }, [steps, isDone]);

    const [selectedIdx, setSelectedIdx] = useState(0);
    const [expanded, setExpanded] = useState(false);

    // Auto-select and auto-expand the first failed step the moment we
    // transition to 'done'. Otherwise default to the last step so the
    // user sees the most recent output.
    useEffect(() => {
        if (!isDone) return;
        if (steps.length === 0) return;
        if (firstFailedIdx >= 0) {
            setSelectedIdx(firstFailedIdx);
            setExpanded(true);
        } else {
            setSelectedIdx(steps.length - 1);
            setExpanded(false);
        }
    }, [isDone, firstFailedIdx, steps.length]);

    useInput(
        (input, key) => {
            if (!focused || !isDone) return;
            if (key.escape) {
                onClose?.();
                return;
            }
            if (key.upArrow) {
                setSelectedIdx((i) => Math.max(0, i - 1));
                return;
            }
            if (key.downArrow) {
                setSelectedIdx((i) => Math.min(steps.length - 1, i + 1));
                return;
            }
            if (key.return || input === ' ') {
                setExpanded((e) => !e);
            }
        },
        { isActive: !!focused && isDone },
    );

    const header =
        state.phase === 'running'
            ? 'RUNNING'
            : state.result?.ok
              ? 'DONE · OK'
              : 'DONE · FAILED';
    const headerColor =
        state.phase === 'running'
            ? theme.accent
            : state.result?.ok
              ? theme.lime
              : theme.red;

    const selected = isDone ? steps[selectedIdx] : null;

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
            {steps.map((s, i) => (
                <StepLine
                    key={s.index}
                    step={s}
                    selected={isDone && i === selectedIdx}
                    expanded={isDone && i === selectedIdx && expanded}
                    focused={!!focused}
                />
            ))}
            {state.phase === 'done' && !state.result?.ok && state.result?.error && (
                <Box marginTop={1}>
                    <Text color={theme.red}>{state.result.error}</Text>
                </Box>
            )}
            {isDone && expanded && selected && (
                <StepOutputView step={selected} maxLines={maxOutputLines} />
            )}
            {isDone && (
                <Box marginTop={1}>
                    <Text color={theme.fgFaint}>
                        ↑↓ step · enter {expanded ? 'collapse' : 'expand'} · esc close
                    </Text>
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

export function PlaybookRunView({ state, focused, onClose, maxOutputLines }) {
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
                <SingleRunBody
                    state={state}
                    focused={focused}
                    onClose={onClose}
                    maxOutputLines={maxOutputLines}
                />
            )}
        </Panel>
    );
}
