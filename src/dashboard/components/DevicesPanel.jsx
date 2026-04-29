import React, { useEffect, useMemo } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { theme } from '../theme.js';
import { Panel } from './Panel.jsx';
import { Sparkline, colorForPct } from './Sparkline.jsx';
import { deviceHealth } from '../lib/status.js';
import { filterDevicesByMetric } from '../../../lib/dashboard/metric-filter.js';

const SORT_OPTIONS = ['status', 'name', 'cpu', 'mem', 'disk', 'up'];

function dotFor(health) {
    if (health === 'on') return { glyph: '●', color: theme.lime };
    if (health === 'warn') return { glyph: '▲', color: theme.amber };
    if (health === 'bad') return { glyph: '✕', color: theme.red };
    return { glyph: '○', color: theme.fgFaint };
}

function uptimeSeconds(sample) {
    if (!sample?.uptime) return 0;
    return Number(sample.uptime) || 0;
}

function fmtNum(value, color) {
    if (value == null) return <Text color={theme.fgFaint}>—</Text>;
    return <Text color={color}>{Math.round(value)}</Text>;
}

function colorPct(p, warn = 75, bad = 90) {
    if (p == null) return theme.fgFaint;
    if (p >= bad) return theme.red;
    if (p >= warn) return theme.amber;
    return theme.fg;
}

// Keep the uptime column to at most 5 characters so it fits the header
// width without wrapping even on long-lived servers (800+ days). At
// multi-day scale hours stop being informative, so we drop them.
function fmtUp(seconds) {
    if (!seconds) return '—';
    const d = Math.floor(seconds / 86400);
    if (d >= 10) return `${d}d`;
    const h = Math.floor((seconds % 86400) / 3600);
    if (d > 0) return `${d}d${h}h`;
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h${m}m`;
    return `${m}m`;
}

function HeaderCell({ label, sortKey, currentSort, width, align = 'left' }) {
    const active = currentSort === sortKey;
    const color = active ? theme.accent : theme.fgFaint;
    return (
        <Box width={width} justifyContent={align === 'right' ? 'flex-end' : 'flex-start'}>
            <Text color={color}>{label}</Text>
        </Box>
    );
}

export function DevicesPanel({
    devices,
    samples,
    cpuHistory,
    alarmSeverityByDevice,
    loading,
    error,
    focused,
    selectedId,
    onSelect,
    sort = 'status',
    filter = '',
    filtering = false,
    metricFilter = null,
    valuesByDevice = null,
}) {
    const scopedDevices = useMemo(
        () => filterDevicesByMetric(devices, valuesByDevice, metricFilter),
        [devices, valuesByDevice, metricFilter],
    );

    const enriched = useMemo(() => {
        return scopedDevices.map((d) => {
            const sample = samples?.[d.device];
            return {
                d,
                sample,
                health: deviceHealth(d, alarmSeverityByDevice?.get(d.device)),
                cpu: sample?.cpu?.usage ?? null,
                mem: sample?.memory?.usage ?? null,
                disk: sample?.disk?.root?.usage ?? null,
                up: uptimeSeconds(sample),
            };
        });
    }, [scopedDevices, samples, alarmSeverityByDevice]);

    const sorted = useMemo(() => {
        const order = { bad: 0, warn: 1, on: 2, off: 3 };
        const copy = [...enriched];
        copy.sort((a, b) => {
            if (sort === 'name') return a.d.device.localeCompare(b.d.device);
            if (sort === 'cpu') return (b.cpu ?? -1) - (a.cpu ?? -1);
            if (sort === 'mem') return (b.mem ?? -1) - (a.mem ?? -1);
            if (sort === 'disk') return (b.disk ?? -1) - (a.disk ?? -1);
            if (sort === 'up') return b.up - a.up;
            // status (default): worst first, then name
            const oo = order[a.health] - order[b.health];
            if (oo !== 0) return oo;
            return a.d.device.localeCompare(b.d.device);
        });
        if (!filter) return copy;
        const needle = filter.toLowerCase();
        return copy.filter(
            (e) =>
                e.d.device.toLowerCase().includes(needle) ||
                (e.d.name && e.d.name.toLowerCase().includes(needle)),
        );
    }, [enriched, sort, filter]);

    const selectedIndex = useMemo(() => {
        const idx = sorted.findIndex((e) => e.d.device === selectedId);
        return idx >= 0 ? idx : 0;
    }, [sorted, selectedId]);

    useEffect(() => {
        if (sorted.length === 0) return;
        const current = sorted[selectedIndex];
        if (!current) return;
        if (current.d.device !== selectedId) onSelect(current.d.device);
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
            onSelect(sorted[next].d.device);
        },
        { isActive: focused },
    );

    const idWidth = sorted.reduce((w, e) => Math.max(w, e.d.device.length), 8);
    const { stdout } = useStdout();
    // Header (~3) + footer (~3) + panel border (2) + title row + margin (1) +
    // possible overflow indicators (2) + column header (1): the list itself
    // gets the rest.
    const visibleCount = Math.max(3, (stdout?.rows ?? 40) - 12);

    let start = 0;
    let end = sorted.length;
    if (sorted.length > visibleCount) {
        const half = Math.floor(visibleCount / 2);
        start = Math.max(0, Math.min(selectedIndex - half, sorted.length - visibleCount));
        end = start + visibleCount;
    }
    const slice = sorted.slice(start, end);
    const hiddenAbove = start;
    const hiddenBelow = sorted.length - end;

    const subText =
        metricFilter || filter
            ? `${sorted.length} / ${devices.length}`
            : `${sorted.length}`;
    return (
        <Panel
            title="DEVICES"
            sub={subText}
            focused={focused}
            right={
                metricFilter ? (
                    <Text>
                        <Text color={theme.fgFaint}>
                            {metricFilter.label || metricFilter.metricKey} =
                            {' '}
                        </Text>
                        <Text color={theme.accent} bold>
                            {metricFilter.bucket}
                        </Text>
                    </Text>
                ) : filtering || filter ? (
                    <Box>
                        <Text color={filtering ? theme.accent : theme.fgDim}>/</Text>
                        <Text color={theme.fg}>{filter}</Text>
                        {filtering && <Text color={theme.accent}>▌</Text>}
                    </Box>
                ) : (
                    <Text>
                        <Text color={theme.fgFaint}>sort </Text>
                        <Text color={theme.accent}>{sort}</Text>
                    </Text>
                )
            }
        >
            <Box>
                <Box width={2} />
                <HeaderCell label="name" sortKey="name" currentSort={sort} width={idWidth + 2} />
                <Box width={2} />
                <Box width={12} marginRight={1} paddingRight={2} justifyContent="flex-end">
                    <Text color={theme.fgFaint}>30m</Text>
                </Box>
                <HeaderCell label="cpu" sortKey="cpu" currentSort={sort} width={5} align="right" />
                <HeaderCell label="mem" sortKey="mem" currentSort={sort} width={5} align="right" />
                <HeaderCell label="disk" sortKey="disk" currentSort={sort} width={5} align="right" />
                <HeaderCell label="up" sortKey="up" currentSort={sort} width={6} align="right" />
            </Box>

            {loading && sorted.length === 0 && (
                <Text color={theme.fgDim}>loading…</Text>
            )}
            {error && <Text color={theme.red}>{error}</Text>}

            {hiddenAbove > 0 && <Text color={theme.fgFaint}>↑ {hiddenAbove} more</Text>}

            <Box flexDirection="column">
                {slice.map((e) => {
                    const isSel = e.d.device === selectedId;
                    const dot = dotFor(e.health);
                    const id = e.d.device.padEnd(idWidth);
                    const cpuSeries = cpuHistory?.[e.d.device];
                    const hasSpark = Array.isArray(cpuSeries) && cpuSeries.length >= 2;
                    const sparkColor = e.cpu == null ? theme.fgDim : colorForPct(e.cpu);
                    return (
                        <Box key={e.d.device} backgroundColor={isSel ? '#1a2030' : undefined}>
                            <Box width={2}>
                                <Text color={isSel ? theme.accent : undefined}>
                                    {isSel ? '›' : ' '}
                                </Text>
                            </Box>
                            <Box width={idWidth + 2} marginRight={2}>
                                <Text wrap="truncate-end">
                                    <Text color={dot.color}>{dot.glyph}</Text>{' '}
                                    <Text color={isSel ? theme.fg : theme.fgDim}>{id}</Text>
                                </Text>
                            </Box>
                            <Box width={12} marginRight={1}>
                                {hasSpark ? (
                                    <Sparkline series={cpuSeries} width={10} color={sparkColor} />
                                ) : (
                                    <Text color={theme.fgFaint}>{'·'.repeat(10)}</Text>
                                )}
                            </Box>
                            <Box width={5} justifyContent="flex-end">
                                {fmtNum(e.cpu, colorPct(e.cpu))}
                            </Box>
                            <Box width={5} justifyContent="flex-end">
                                {fmtNum(e.mem, colorPct(e.mem))}
                            </Box>
                            <Box width={5} justifyContent="flex-end">
                                {fmtNum(e.disk, colorPct(e.disk, 85, 95))}
                            </Box>
                            <Box width={6} justifyContent="flex-end" flexShrink={0}>
                                <Text color={theme.fgDim} wrap="truncate">
                                    {fmtUp(e.up)}
                                </Text>
                            </Box>
                        </Box>
                    );
                })}
            </Box>

            {hiddenBelow > 0 && <Text color={theme.fgFaint}>↓ {hiddenBelow} more</Text>}
        </Panel>
    );
}

export { SORT_OPTIONS };
