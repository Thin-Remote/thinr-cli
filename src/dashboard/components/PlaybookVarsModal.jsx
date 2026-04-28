import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';

const MIN_BATCH = 1;
const MAX_BATCH = 50;

// A single text input line with cursor + keyboard editing. The caller
// drives focus and value — we keep the implementation local so each var
// field can share exactly the same behaviour without pulling in a UI lib.
function TextField({ value, focused, onChange }) {
    const display = value ?? '';
    if (focused) {
        return (
            <Text>
                <Text color={theme.fg}>{display}</Text>
                <Text color={theme.accent} inverse>
                    {' '}
                </Text>
            </Text>
        );
    }
    return <Text color={theme.fg}>{display.length ? display : ' '}</Text>;
}

function serializeDefault(value, type) {
    if (value === undefined) return '';
    if (value === null) return '';
    if (type === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return '';
        }
    }
    return String(value);
}

function coerce(raw, type) {
    const s = raw ?? '';
    switch (type) {
        case 'string':
            return { ok: true, value: s };
        case 'number': {
            if (s === '') return { ok: false, error: 'number required' };
            const n = Number(s);
            if (!Number.isFinite(n)) return { ok: false, error: 'not a finite number' };
            return { ok: true, value: n };
        }
        case 'boolean':
            if (s === 'true') return { ok: true, value: true };
            if (s === 'false') return { ok: true, value: false };
            return { ok: false, error: 'expected true or false' };
        case 'object':
            if (s.trim() === '') return { ok: false, error: 'JSON required' };
            try {
                return { ok: true, value: JSON.parse(s) };
            } catch (err) {
                return { ok: false, error: err.message || 'invalid JSON' };
            }
        default:
            return { ok: true, value: s };
    }
}

/**
 * Variables editor + run options modal. Used for both single-device and
 * fleet runs — fleet mode also exposes batch size, failure threshold and
 * the include-offline toggle (the task spec lists offline inclusion as
 * part of the rollout form).
 */
export function PlaybookVarsModal({
    playbookName,
    mode,
    variables,
    device,
    deviceCount,
    batchSize: initialBatchSize = 5,
    failureThreshold: initialFailureThreshold = 10,
    includeOffline: initialIncludeOffline = false,
    onSubmit,
    onCancel,
}) {
    // Strings to match what the user actually types. We coerce back to
    // the declared type only at submit time.
    const initialFields = useMemo(
        () =>
            (variables || []).map((v) => ({
                name: v.name,
                description: v.description,
                type: v.type,
                overridable: v.overridable,
                required: v.required,
                hasDefault: v.hasDefault,
                original: v.default,
                text: serializeDefault(v.default, v.type),
            })),
        [variables],
    );

    const editableIndices = useMemo(
        () => initialFields.map((f, i) => (f.overridable ? i : -1)).filter((i) => i >= 0),
        [initialFields],
    );
    const hasEditableVars = editableIndices.length > 0;

    // Focus cursor. Navigates through editable vars, then fleet-only
    // controls, then actions. We store focus as a unified index into a
    // flat list of focusable targets so the tab key moves in one line.
    const extraTargets =
        mode === 'fleet'
            ? ['batch', 'threshold', 'offline', 'submit', 'cancel']
            : ['submit', 'cancel'];
    const focusOrder = [...editableIndices.map((i) => `var:${i}`), ...extraTargets];

    const [fields, setFields] = useState(initialFields);
    const [batch, setBatch] = useState(initialBatchSize);
    const [threshold, setThreshold] = useState(initialFailureThreshold);
    const [includeOffline, setIncludeOffline] = useState(!!initialIncludeOffline);
    const [focusIdx, setFocusIdx] = useState(0);
    const [error, setError] = useState(null);

    const currentFocus = focusOrder[focusIdx] ?? focusOrder[0];

    const setVarText = (varIndex, updater) => {
        setFields((prev) =>
            prev.map((f, i) => (i === varIndex ? { ...f, text: updater(f.text) } : f)),
        );
    };

    const moveFocus = (delta) => {
        if (focusOrder.length === 0) return;
        setFocusIdx((idx) => (idx + delta + focusOrder.length) % focusOrder.length);
    };

    const trySubmit = () => {
        const overrides = {};
        for (const f of fields) {
            if (!f.overridable) continue;
            if (!f.text || f.text.length === 0) {
                if (f.required && !f.hasDefault) {
                    setError(`"${f.name}" is required.`);
                    return;
                }
                // Empty and optional and no default → skip override.
                if (!f.hasDefault) continue;
                // Empty with a default → no override, use the default.
                continue;
            }
            // If the user left the stringified default untouched, skip
            // the override so the runner uses the parsed default value
            // (e.g. JSON objects survive round-tripping).
            if (
                f.hasDefault &&
                f.text === serializeDefault(f.original, f.type)
            ) {
                continue;
            }
            const c = coerce(f.text, f.type);
            if (!c.ok) {
                setError(`"${f.name}": ${c.error}`);
                return;
            }
            overrides[f.name] = c.value;
        }
        setError(null);
        onSubmit({
            overrides,
            batchSize: batch,
            failureThreshold: threshold,
            includeOffline,
        });
    };

    useInput((input, key) => {
        if (key.escape) {
            onCancel?.();
            return;
        }
        if (key.tab) {
            moveFocus(key.shift ? -1 : 1);
            return;
        }
        if (key.downArrow) {
            moveFocus(1);
            return;
        }
        if (key.upArrow) {
            moveFocus(-1);
            return;
        }

        if (currentFocus === 'submit' && key.return) {
            trySubmit();
            return;
        }
        if (currentFocus === 'cancel' && key.return) {
            onCancel?.();
            return;
        }
        if (key.return) {
            trySubmit();
            return;
        }

        if (currentFocus === 'batch') {
            if (input === '+' || input === '=') {
                setBatch((n) => Math.min(MAX_BATCH, n + 1));
                return;
            }
            if (input === '-' || input === '_') {
                setBatch((n) => Math.max(MIN_BATCH, n - 1));
                return;
            }
            return;
        }
        if (currentFocus === 'threshold') {
            if (input === '+' || input === '=') {
                setThreshold((n) => Math.min(100, n + 5));
                return;
            }
            if (input === '-' || input === '_') {
                setThreshold((n) => Math.max(0, n - 5));
                return;
            }
            return;
        }
        if (currentFocus === 'offline') {
            if (input === ' ' || input === 'o') {
                setIncludeOffline((v) => !v);
                return;
            }
            return;
        }

        if (currentFocus?.startsWith('var:')) {
            const idx = Number(currentFocus.slice(4));
            const field = fields[idx];
            if (!field || !field.overridable) return;
            if (key.backspace || key.delete) {
                setVarText(idx, (t) => t.slice(0, -1));
                return;
            }
            if (input && !key.ctrl && !key.meta && input.length === 1 && input >= ' ') {
                setVarText(idx, (t) => t + input);
            }
        }
    });

    const title =
        mode === 'fleet'
            ? `FLEET ROLLOUT · ${playbookName}`
            : `RUN · ${playbookName}${device ? ` → ${device.device}` : ''}`;

    return (
        <Box
            borderStyle="round"
            borderColor={theme.borderFocus}
            backgroundColor={theme.overlayBg}
            paddingX={2}
            paddingY={1}
            flexDirection="column"
            width={78}
        >
            <Box marginBottom={1} justifyContent="space-between">
                <Text color={theme.accent} bold>
                    {title}
                </Text>
                {mode === 'fleet' && deviceCount != null && (
                    <Text color={theme.fgDim}>
                        {deviceCount} device{deviceCount === 1 ? '' : 's'}
                    </Text>
                )}
            </Box>

            {fields.length === 0 ? (
                <Text color={theme.fgDim}>(playbook declares no variables)</Text>
            ) : (
                <Box flexDirection="column">
                    <Text color={theme.fgDim}>Variables (tab to move, enter to submit):</Text>
                    {fields.map((f, i) => {
                        const isFocused = currentFocus === `var:${i}`;
                        const readOnly = !f.overridable;
                        return (
                            <Box key={f.name} marginTop={0} flexDirection="column">
                                <Box>
                                    <Box width={20}>
                                        <Text
                                            color={
                                                isFocused
                                                    ? theme.accent
                                                    : readOnly
                                                      ? theme.fgFaint
                                                      : theme.fg
                                            }
                                            bold={isFocused}
                                        >
                                            {f.name}
                                            {f.required ? '*' : ''}
                                        </Text>
                                    </Box>
                                    <Box width={10}>
                                        <Text color={theme.fgFaint}>{f.type}</Text>
                                    </Box>
                                    <Box flexGrow={1}>
                                        {readOnly ? (
                                            <Text color={theme.fgFaint}>
                                                {f.text || '(not overridable)'}
                                            </Text>
                                        ) : (
                                            <TextField
                                                value={f.text}
                                                focused={isFocused}
                                                onChange={() => {}}
                                            />
                                        )}
                                    </Box>
                                </Box>
                                {f.description && isFocused && (
                                    <Box marginLeft={20}>
                                        <Text color={theme.fgDim}>{f.description}</Text>
                                    </Box>
                                )}
                            </Box>
                        );
                    })}
                </Box>
            )}

            {mode === 'fleet' && (
                <Box marginTop={1} flexDirection="column">
                    <Text color={theme.fgDim}>Rollout:</Text>
                    <Box>
                        <Box width={20}>
                            <Text
                                color={
                                    currentFocus === 'batch' ? theme.accent : theme.fgDim
                                }
                                bold={currentFocus === 'batch'}
                            >
                                batch size
                            </Text>
                        </Box>
                        <Text color={theme.fg}>{batch}</Text>
                        <Text color={theme.fgFaint}>  (+/-)</Text>
                    </Box>
                    <Box>
                        <Box width={20}>
                            <Text
                                color={
                                    currentFocus === 'threshold'
                                        ? theme.accent
                                        : theme.fgDim
                                }
                                bold={currentFocus === 'threshold'}
                            >
                                abort at failures
                            </Text>
                        </Box>
                        <Text color={theme.fg}>{threshold}%</Text>
                        <Text color={theme.fgFaint}>  (+/-)</Text>
                    </Box>
                    <Box>
                        <Box width={20}>
                            <Text
                                color={
                                    currentFocus === 'offline'
                                        ? theme.accent
                                        : theme.fgDim
                                }
                                bold={currentFocus === 'offline'}
                            >
                                include offline
                            </Text>
                        </Box>
                        <Text color={includeOffline ? theme.lime : theme.fgDim}>
                            {includeOffline ? '[x]' : '[ ]'}
                        </Text>
                        <Text color={theme.fgFaint}>  (space)</Text>
                    </Box>
                </Box>
            )}

            {error && (
                <Box marginTop={1}>
                    <Text color={theme.red}>{error}</Text>
                </Box>
            )}

            <Box marginTop={1} justifyContent="space-between">
                <Box>
                    <Text
                        color={currentFocus === 'submit' ? theme.accent : theme.fgDim}
                        bold={currentFocus === 'submit'}
                    >
                        {currentFocus === 'submit' ? '▶ ' : '  '}
                        enter {mode === 'fleet' ? 'start rollout' : 'run playbook'}
                    </Text>
                </Box>
                <Box>
                    <Text
                        color={currentFocus === 'cancel' ? theme.amber : theme.fgDim}
                        bold={currentFocus === 'cancel'}
                    >
                        esc cancel
                    </Text>
                </Box>
            </Box>
            {!hasEditableVars && mode === 'single' && (
                <Box marginTop={1}>
                    <Text color={theme.fgFaint}>
                        No overridable variables — press enter to continue.
                    </Text>
                </Box>
            )}
        </Box>
    );
}
