import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { theme } from './theme.js';
import { Header, TABS } from './components/Header.jsx';
import { Footer } from './components/Footer.jsx';
import { DevicesPanel, SORT_OPTIONS } from './components/DevicesPanel.jsx';
import { DeviceDetailPanel } from './components/DeviceDetailPanel.jsx';
import { OverviewTab } from './components/OverviewTab.jsx';
import { AlertsTab } from './components/AlertsTab.jsx';
import { EventsTab } from './components/EventsTab.jsx';
import { useDevices } from './hooks/useDevices.js';
import { useFleetMonitoringStream } from './hooks/useFleetMonitoringStream.js';
import { fleetCounts } from './lib/status.js';

const PANELS = ['devices', 'detail'];
const MIN_COLS = 90;
const MIN_ROWS = 18;

const TAB_HINTS = {
    overview: [
        { k: '1-4', label: 'tabs' },
        { k: 'q', label: 'quit' },
    ],
    devices: [
        { k: '1-4', label: 'tabs' },
        { k: '↑↓', label: 'nav' },
        { k: 's', label: 'sort' },
        { k: 'p', label: 'pause' },
        { k: 'c', label: 'clear' },
        { k: 'enter', label: 'console' },
        { k: '/', label: 'filter' },
        { k: 'q', label: 'quit' },
    ],
    alerts: [
        { k: '1-4', label: 'tabs' },
        { k: 'q', label: 'quit' },
    ],
    events: [
        { k: '1-4', label: 'tabs' },
        { k: 'q', label: 'quit' },
    ],
};

export function App({ server, onAction }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [tab, setTab] = useState('devices');
    const [focus, setFocus] = useState('devices');
    const [selectedId, setSelectedId] = useState(null);
    const [sort, setSort] = useState('status');
    const [filter, setFilter] = useState('');
    const [filtering, setFiltering] = useState(false);
    const [paused, setPaused] = useState(false);
    const [logsClearToken, setLogsClearToken] = useState(0);
    const [size, setSize] = useState(() => ({
        cols: stdout?.columns ?? 80,
        rows: stdout?.rows ?? 24,
    }));

    useEffect(() => {
        if (!stdout) return;
        const update = () =>
            setSize({ cols: stdout.columns, rows: stdout.rows });
        // Re-measure right after mount — the alt-screen toggle can make the
        // initial read arrive 1–2 rows short on some terminals.
        const t = setTimeout(update, 30);
        stdout.on('resize', update);
        return () => {
            clearTimeout(t);
            stdout.off('resize', update);
        };
    }, [stdout]);

    const { devices, loading, error } = useDevices();
    const { samples, history, events } = useFleetMonitoringStream(devices);
    const counts = useMemo(() => fleetCounts(devices, samples), [devices, samples]);
    const selected = devices.find((d) => d.device === selectedId);
    const selectedOnline = !!selected?.connection?.active;

    useInput((input, key) => {
        if (filtering) {
            if (key.escape) {
                setFilter('');
                setFiltering(false);
                return;
            }
            if (key.return || key.downArrow || key.upArrow) {
                setFiltering(false);
                return;
            }
            if (key.backspace || key.delete) {
                setFilter((f) => f.slice(0, -1));
                return;
            }
            // Accept printable characters only — avoids swallowing arrow/ctrl keys.
            if (input && !key.ctrl && !key.meta && input.length === 1 && input >= ' ') {
                setFilter((f) => f + input);
            }
            return;
        }
        // Tab switching works from anywhere that isn't mid-filter.
        const tabHit = TABS.find((t) => t.key === input);
        if (tabHit) {
            setTab(tabHit.id);
            return;
        }
        if (input === 'q' || (key.ctrl && input === 'c')) exit();
        if (tab !== 'devices') return;
        if (input === '/') {
            setFocus('devices');
            setFiltering(true);
            return;
        }
        if (input === 's') {
            setSort((cur) => {
                const i = SORT_OPTIONS.indexOf(cur);
                return SORT_OPTIONS[(i + 1) % SORT_OPTIONS.length];
            });
            return;
        }
        if (key.return && selected && selectedOnline) {
            onAction?.({ type: 'console', deviceId: selected.device });
            exit();
            return;
        }
        // Log controls are global within the devices tab so you don't have to
        // hunt for focus.
        if (input === 'p') {
            setPaused((p) => !p);
            return;
        }
        if (input === 'c') {
            setLogsClearToken((n) => n + 1);
            return;
        }
        if (key.tab || key.rightArrow) {
            const i = PANELS.indexOf(focus);
            const delta = key.shift && key.tab ? -1 : 1;
            setFocus(PANELS[(i + delta + PANELS.length) % PANELS.length]);
            return;
        }
        if (key.leftArrow) {
            const i = PANELS.indexOf(focus);
            setFocus(PANELS[(i - 1 + PANELS.length) % PANELS.length]);
            return;
        }
    });

    if (size.cols < MIN_COLS || size.rows < MIN_ROWS) {
        return (
            <Box
                width={size.cols}
                height={size.rows}
                alignItems="center"
                justifyContent="center"
                flexDirection="column"
            >
                <Text color={theme.warn}>terminal too small</Text>
                <Text color={theme.muted}>
                    need at least {MIN_COLS}×{MIN_ROWS} ({size.cols}×{size.rows})
                </Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column" width={size.cols} height={size.rows}>
            <Header tab={tab} onTab={setTab} counts={counts} server={server} />

            {tab === 'devices' && (
                <Box flexGrow={1}>
                    <Box width="38%" flexDirection="column">
                        <DevicesPanel
                            devices={devices}
                            samples={samples}
                            loading={loading}
                            error={error}
                            focused={focus === 'devices'}
                            selectedId={selectedId}
                            onSelect={setSelectedId}
                            sort={sort}
                            filter={filter}
                            filtering={filtering}
                        />
                    </Box>

                    <Box flexGrow={1} flexDirection="column">
                        <DeviceDetailPanel
                            device={selected}
                            sample={selected ? samples[selected.device] : null}
                            paused={paused}
                            clearToken={logsClearToken}
                            focused={focus === 'detail'}
                        />
                    </Box>
                </Box>
            )}

            {tab === 'overview' && (
                <OverviewTab
                    devices={devices}
                    samples={samples}
                    history={history}
                    events={events}
                />
            )}

            {tab === 'alerts' && <AlertsTab devices={devices} samples={samples} />}

            {tab === 'events' && <EventsTab events={events} />}

            <Footer hints={TAB_HINTS[tab]} right="v1.2.0 · agent ok" />
        </Box>
    );
}
