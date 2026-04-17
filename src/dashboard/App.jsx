import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { theme } from './theme.js';
import { Header } from './components/Header.jsx';
import { Footer } from './components/Footer.jsx';
import { DevicesPanel } from './components/DevicesPanel.jsx';
import { MonitoringPanel } from './components/MonitoringPanel.jsx';
import { LogsPanel } from './components/LogsPanel.jsx';
import { useDevices } from './hooks/useDevices.js';

const PANELS = ['devices', 'monitoring', 'logs'];
const MIN_COLS = 90;
const MIN_ROWS = 18;

export function App({ server, onAction }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [focus, setFocus] = useState('devices');
    const [selectedId, setSelectedId] = useState(null);
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
    const online = devices.filter((d) => d.connection?.active).length;
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
        if (input === 'q' || (key.ctrl && input === 'c')) exit();
        if (input === '/') {
            setFocus('devices');
            setFiltering(true);
            return;
        }
        if (key.return && focus === 'devices' && selected && selectedOnline) {
            onAction?.({ type: 'console', deviceId: selected.device });
            exit();
            return;
        }
        // Log controls are global so you don't have to hunt for focus.
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
            <Header total={devices.length} online={online} server={server} />

            <Box flexGrow={1}>
                <Box width="38%" flexDirection="column">
                    <DevicesPanel
                        devices={devices}
                        loading={loading}
                        error={error}
                        focused={focus === 'devices'}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                        filter={filter}
                        filtering={filtering}
                    />
                </Box>

                <Box flexGrow={1} flexDirection="column">
                    <MonitoringPanel
                        deviceId={selectedId}
                        focused={focus === 'monitoring'}
                    />
                    <LogsPanel
                        deviceId={selectedId}
                        online={selectedOnline}
                        focused={focus === 'logs'}
                        paused={paused}
                        clearToken={logsClearToken}
                    />
                </Box>
            </Box>

            <Footer
                hints={[
                    { k: '↑↓', label: 'nav' },
                    { k: '←→', label: 'panel' },
                    { k: 'p', label: 'pause' },
                    { k: 'c', label: 'clear' },
                    { k: 'enter', label: 'console' },
                    { k: '/', label: 'filter' },
                    { k: 'q', label: 'quit' },
                ]}
            />
        </Box>
    );
}
