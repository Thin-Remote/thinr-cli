import React, { useEffect, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { theme } from '../theme.js';

function formatRelative(ts) {
    if (!ts) return '—';
    const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
}

export function DevicesPanel({
    devices,
    loading,
    error,
    focused,
    selectedId,
    onSelect,
    filter = '',
    filtering = false,
}) {
    const sorted = useMemo(() => {
        const base = [...devices].sort((a, b) => {
            const ao = a.connection?.active ? 0 : 1;
            const bo = b.connection?.active ? 0 : 1;
            if (ao !== bo) return ao - bo;
            return a.device.localeCompare(b.device);
        });
        if (!filter) return base;
        const needle = filter.toLowerCase();
        return base.filter(
            (d) =>
                d.device.toLowerCase().includes(needle) ||
                (d.name && d.name.toLowerCase().includes(needle)),
        );
    }, [devices, filter]);

    const selectedIndex = useMemo(() => {
        const idx = sorted.findIndex((d) => d.device === selectedId);
        return idx >= 0 ? idx : 0;
    }, [sorted, selectedId]);

    useEffect(() => {
        if (sorted.length === 0) return;
        const current = sorted[selectedIndex];
        if (!current) return;
        if (current.device !== selectedId) onSelect(current.device);
    }, [sorted, selectedIndex, selectedId, onSelect]);

    useInput(
        (input, key) => {
            if (!focused || filtering || sorted.length === 0) return;
            let next = selectedIndex;
            if (key.upArrow || input === 'k') next = Math.max(0, selectedIndex - 1);
            else if (key.downArrow || input === 'j')
                next = Math.min(sorted.length - 1, selectedIndex + 1);
            else if (key.pageUp) next = Math.max(0, selectedIndex - 10);
            else if (key.pageDown) next = Math.min(sorted.length - 1, selectedIndex + 10);
            else if (input === 'g') next = 0;
            else if (input === 'G') next = sorted.length - 1;
            else return;
            onSelect(sorted[next].device);
        },
        { isActive: focused },
    );

    const idWidth = sorted.reduce((w, d) => Math.max(w, d.device.length), 0);
    const borderColor = focused ? theme.borderFocus : theme.border;

    const { stdout } = useStdout();
    // Header (~3) + footer (~3) + panel border (2) + title row + margin (1) +
    // possible overflow indicators (2): the list itself gets the rest.
    const visibleCount = Math.max(3, (stdout?.rows ?? 40) - 11);

    let start = 0;
    let end = sorted.length;
    if (sorted.length > visibleCount) {
        // Keep the selection centered when we can; clamp to the edges at the
        // top and bottom of the list so we use the full viewport.
        const half = Math.floor(visibleCount / 2);
        start = Math.max(0, Math.min(selectedIndex - half, sorted.length - visibleCount));
        end = start + visibleCount;
    }
    const slice = sorted.slice(start, end);
    const hiddenAbove = start;
    const hiddenBelow = sorted.length - end;

    return (
        <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={borderColor}
            paddingX={1}
            flexGrow={1}
        >
            <Box marginBottom={1} justifyContent="space-between">
                <Box>
                    <Text color={theme.muted}>DEVICES</Text>
                    <Text color={theme.dim}>
                        {' '}
                        · {sorted.length}
                        {filter ? ` / ${devices.length}` : ''}
                    </Text>
                </Box>
                {(filtering || filter) && (
                    <Box>
                        <Text color={filtering ? theme.accent : theme.muted}>/</Text>
                        <Text color={theme.fg}>{filter}</Text>
                        {filtering && <Text color={theme.accent}>▌</Text>}
                    </Box>
                )}
            </Box>

            {loading && sorted.length === 0 && <Text color={theme.muted}>loading…</Text>}
            {error && <Text color={theme.err}>{error}</Text>}

            {hiddenAbove > 0 && (
                <Text color={theme.dim}>↑ {hiddenAbove} more</Text>
            )}

            <Box flexDirection="column">
                {slice.map((d) => {
                    const online = d.connection?.active;
                    const isSel = d.device === selectedId;
                    const rowBg = isSel ? theme.dim : undefined;
                    const dot = online ? (
                        <Text color={theme.ok}>●</Text>
                    ) : (
                        <Text color={theme.err}>○</Text>
                    );
                    const id = d.device.padEnd(idWidth);
                    const name = d.name ? ` ${d.name}` : '';
                    const seen = online
                        ? ''
                        : `  ${formatRelative(d.connection?.disconnected_ts || d.last_connection_ts)}`;
                    return (
                        <Box key={d.device} backgroundColor={rowBg}>
                            <Text wrap="truncate-end">
                                {isSel ? (
                                    <Text color={theme.accent}>›</Text>
                                ) : (
                                    <Text> </Text>
                                )}{' '}
                                {dot}{' '}
                                <Text color={isSel ? theme.fg : theme.muted}>{id}</Text>
                                <Text color={theme.dim}>
                                    {name}
                                    {seen}
                                </Text>
                            </Text>
                        </Box>
                    );
                })}
            </Box>

            {hiddenBelow > 0 && (
                <Text color={theme.dim}>↓ {hiddenBelow} more</Text>
            )}
        </Box>
    );
}
