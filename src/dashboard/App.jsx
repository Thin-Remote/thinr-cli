import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useStdout } from 'ink';
import { theme } from './theme.js';
import { Header, TABS } from './components/Header.jsx';
import { Footer } from './components/Footer.jsx';
import { SORT_OPTIONS } from './components/DevicesPanel.jsx';
import { DeviceDetailPanel } from './components/DeviceDetailPanel.jsx';
import { DevicePickerModal } from './components/DevicePickerModal.jsx';
import { OverviewTab } from './components/OverviewTab.jsx';
import { AlertsTab } from './components/AlertsTab.jsx';
import { EventsTab } from './components/EventsTab.jsx';
import { PlaybooksTab } from './components/PlaybooksTab.jsx';
import { ProfilePickerModal } from './components/ProfilePickerModal.jsx';
import { useDevices } from './hooks/useDevices.js';
import { useFleetMonitoringStream } from './hooks/useFleetMonitoringStream.js';
import { useFleetAlarms } from './hooks/useFleetAlarms.js';
import { useFleetProducts } from './hooks/useFleetProducts.js';
import { useProductMetrics } from './hooks/useProductMetrics.js';
import { useLatestAgentVersion } from './hooks/useLatestAgentVersion.js';
import { useUpgradeController } from './hooks/useUpgradeController.js';
import { UpgradeModal } from './components/UpgradeModal.jsx';
import { fleetCounts, maxSeverityByDevice, outdatedDevices } from './lib/status.js';
import {
    FocusProvider,
    useFocusable,
    useFocusHints,
    useGlobalKeys,
    useModal,
    useTabCycle,
} from './lib/focus.js';

const MIN_COLS = 90;
const MIN_ROWS = 18;

// Hints that don't belong to a single panel within a tab. Per-panel hints
// live with the panel via useFocusable, so this map only needs to cover
// info-only tabs and the global baseline.
const STATIC_TAB_HINTS = {
    alerts: [
        { k: '1-5', label: 'tabs' },
        { k: 'q', label: 'quit' },
    ],
    events: [
        { k: '1-5', label: 'tabs' },
        { k: 'q', label: 'quit' },
    ],
    playbooks: [
        { k: '1-5', label: 'tabs' },
        { k: '↑↓', label: 'nav' },
        { k: 'tab', label: 'panel' },
        { k: 't', label: 'test' },
        { k: 'a', label: 'apply' },
        { k: 'x', label: 'delete' },
        { k: 'r', label: 'refresh' },
        { k: 'p', label: 'product' },
        { k: 'q', label: 'quit' },
    ],
};

const FILTER_HINT = [
    { k: 'enter', label: 'apply' },
    { k: 'esc', label: 'cancel' },
];

const DEVICES_DETAIL_HINT = [
    { k: '1-5', label: 'tabs' },
    { k: '/', label: 'switch' },
    { k: 'p', label: 'pause' },
    { k: 'c', label: 'clear' },
    { k: 'enter', label: 'console' },
    { k: 'q', label: 'quit' },
];

export function App({ server, profile, profiles, onAction }) {
    return (
        <FocusProvider>
            <AppInner
                server={server}
                profile={profile}
                profiles={profiles}
                onAction={onAction}
            />
        </FocusProvider>
    );
}

function AppInner({ server, profile, profiles, onAction }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [tab, setTab] = useState('overview');
    const [selectedId, setSelectedId] = useState(null);
    const [sort, setSort] = useState('status');
    const [filter, setFilter] = useState('');
    const [filtering, setFiltering] = useState(false);
    const [paused, setPaused] = useState(false);
    const [logsClearToken, setLogsClearToken] = useState(0);
    const [playbookModalActive, setPlaybookModalActive] = useState(false);
    const [devicePickerOpen, setDevicePickerOpen] = useState(false);
    const [profilePickerOpen, setProfilePickerOpen] = useState(false);
    const profileList = profiles || [];
    const multipleProfiles = profileList.length > 1;
    const [size, setSize] = useState(() => ({
        cols: stdout?.columns ?? 80,
        rows: stdout?.rows ?? 24,
    }));

    useEffect(() => {
        if (!stdout) return;
        const update = () =>
            setSize({ cols: stdout.columns, rows: stdout.rows });
        const t = setTimeout(update, 30);
        stdout.on('resize', update);
        return () => {
            clearTimeout(t);
            stdout.off('resize', update);
        };
    }, [stdout]);

    const { devices, loading, error } = useDevices();
    const { samples, history, cpuHistory, events, pushEvent } = useFleetMonitoringStream(devices);
    const alarms = useFleetAlarms();
    const fleetProductIds = useMemo(() => {
        const set = new Set();
        for (const d of devices) {
            if (d?.product) set.add(d.product);
        }
        return [...set];
    }, [devices]);
    const fleetProducts = useFleetProducts(fleetProductIds);
    const productMetrics = useProductMetrics(fleetProductIds);
    const { latest: latestAgentVersion } = useLatestAgentVersion();
    const upgrade = useUpgradeController({ onEvent: pushEvent });
    const alarmSeverityByDevice = useMemo(
        () => maxSeverityByDevice(alarms.instances, devices),
        [alarms.instances, devices],
    );
    const counts = useMemo(
        () => fleetCounts(devices, alarmSeverityByDevice),
        [devices, alarmSeverityByDevice],
    );
    const outdated = useMemo(
        () =>
            latestAgentVersion ? outdatedDevices(devices, samples, latestAgentVersion) : [],
        [devices, samples, latestAgentVersion],
    );
    const selected = devices.find((d) => d.device === selectedId);
    const selectedOnline = !!selected?.connection?.active;

    // Top-level tab routing + quit. Yields to any modal on the stack so
    // `1-5` and `q` don't escape filter mode or modals unexpectedly.
    useGlobalKeys(
        (input, key) => {
            const tabHit = TABS.find((t) => t.key === input);
            if (tabHit) {
                setTab(tabHit.id);
                return;
            }
            if (input === 'q' || (key.ctrl && input === 'c')) exit();
        },
        { when: !playbookModalActive },
    );

    useGlobalKeys(
        (input) => {
            if (input === 'p') setProfilePickerOpen(true);
        },
        { when: tab === 'overview' && multipleProfiles && !playbookModalActive },
    );

    // Filter mode: while active, modal owns input and shows its own hints.
    useModal(
        (input, key) => {
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
            if (input && !key.ctrl && !key.meta && input.length === 1 && input >= ' ') {
                setFilter((f) => f + input);
            }
        },
        { when: filtering, hint: FILTER_HINT },
    );

    // Tab cycle + per-panel focusable handlers for the devices-detail tab.
    useTabCycle('devices', { when: tab === 'devices' });
    useFocusable({
        id: 'devices-detail',
        parent: 'devices',
        when: tab === 'devices',
        hint: DEVICES_DETAIL_HINT,
        handlers: (input, key) => {
            if (input === '/') {
                setDevicePickerOpen(true);
                return;
            }
            if (key.return && selected && selectedOnline) {
                onAction?.({ type: 'console', deviceId: selected.device });
                exit();
                return;
            }
            if (input === 'p') setPaused((p) => !p);
            else if (input === 'c') setLogsClearToken((n) => n + 1);
        },
    });

    const overviewHints = useFocusHints('overview');
    const devicesHints = useFocusHints('devices');
    const footerHints =
        tab === 'overview'
            ? overviewHints
            : tab === 'devices'
              ? devicesHints
              : STATIC_TAB_HINTS[tab] || [];

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
            <Header
                tab={tab}
                onTab={setTab}
                counts={counts}
                server={server}
                profile={profile}
                multipleProfiles={multipleProfiles}
            />

            {tab === 'devices' && (
                <Box flexGrow={1} flexDirection="column">
                    <DeviceDetailPanel
                        device={selected}
                        sample={selected ? samples[selected.device] : null}
                        alarmSeverity={
                            selected ? alarmSeverityByDevice.get(selected.device) : undefined
                        }
                        paused={paused}
                        clearToken={logsClearToken}
                        focused
                    />
                </Box>
            )}

            {tab === 'overview' && (
                <OverviewTab
                    devices={devices}
                    samples={samples}
                    history={history}
                    cpuHistory={cpuHistory}
                    events={events}
                    alarms={alarms}
                    alarmSeverityByDevice={alarmSeverityByDevice}
                    productMetrics={productMetrics}
                    productInfo={fleetProducts}
                    latestAgentVersion={latestAgentVersion}
                    outdatedCount={outdated.length}
                    upgradeState={upgrade.state}
                    selectedId={selectedId}
                    onSelectDevice={setSelectedId}
                    sort={sort}
                    onCycleSort={() =>
                        setSort((cur) => {
                            const i = SORT_OPTIONS.indexOf(cur);
                            return SORT_OPTIONS[(i + 1) % SORT_OPTIONS.length];
                        })
                    }
                    filter={filter}
                    filtering={filtering}
                    onStartFilter={() => setFiltering(true)}
                    onConfirmDevice={() => setTab('devices')}
                    onRequestUpgrade={() => {
                        if (
                            latestAgentVersion &&
                            outdated.length > 0 &&
                            upgrade.state.phase === 'idle'
                        ) {
                            upgrade.openConfirm(latestAgentVersion, outdated);
                        }
                    }}
                    devicesLoading={loading}
                    devicesError={error}
                />
            )}

            {upgrade.state.phase === 'confirming' && (
                <Box
                    position="absolute"
                    width={size.cols}
                    height={size.rows}
                    alignItems="center"
                    justifyContent="center"
                >
                    <UpgradeModal
                        outdatedCount={upgrade.state.outdatedCount}
                        target={upgrade.state.target}
                        onConfirm={(opts) => upgrade.start(opts)}
                        onCancel={() => upgrade.cancelConfirm()}
                    />
                </Box>
            )}

            {devicePickerOpen && (
                <Box
                    position="absolute"
                    width={size.cols}
                    height={size.rows}
                    alignItems="center"
                    justifyContent="center"
                >
                    <DevicePickerModal
                        title="SWITCH DEVICE"
                        devices={devices}
                        onSelect={(d) => {
                            setSelectedId(d.device);
                            setDevicePickerOpen(false);
                        }}
                        onCancel={() => setDevicePickerOpen(false)}
                    />
                </Box>
            )}

            {profilePickerOpen && (
                <Box
                    position="absolute"
                    width={size.cols}
                    height={size.rows}
                    alignItems="center"
                    justifyContent="center"
                >
                    <ProfilePickerModal
                        profiles={profileList}
                        active={profile}
                        onSelect={(name) => {
                            setProfilePickerOpen(false);
                            onAction?.({ type: 'profile', name });
                            exit();
                        }}
                        onCancel={() => setProfilePickerOpen(false)}
                    />
                </Box>
            )}

            {tab === 'alerts' && <AlertsTab alarms={alarms} />}

            {tab === 'events' && <EventsTab events={events} />}

            {tab === 'playbooks' && (
                <PlaybooksTab
                    devices={devices}
                    focused={tab === 'playbooks'}
                    onModalActiveChange={setPlaybookModalActive}
                />
            )}

            <Footer hints={footerHints} right="v1.2.0 · agent ok" />
        </Box>
    );
}
