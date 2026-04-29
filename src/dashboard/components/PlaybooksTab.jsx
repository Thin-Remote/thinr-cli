import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { theme } from '../theme.js';
import { Panel } from './Panel.jsx';
import { PlaybookRunView } from './PlaybookRunView.jsx';
import { PlaybookReportView } from './PlaybookReportView.jsx';
import { PlaybookVarsModal } from './PlaybookVarsModal.jsx';
import { DevicePickerModal } from './DevicePickerModal.jsx';
import { ConfirmModal } from './ConfirmModal.jsx';
import { useProductPlaybooks } from '../hooks/useProductPlaybooks.js';
import { usePlaybookRunController } from '../hooks/usePlaybookRunController.js';
import { filterActiveDevices } from '../../../lib/devices.js';

const PANELS = ['list', 'detail', 'reports'];

function PlaybookList({ playbooks, loading, error, selectedIdx, focused }) {
    if (loading && playbooks.length === 0) {
        return <Text color={theme.fgDim}>loading…</Text>;
    }
    if (error) {
        return <Text color={theme.red}>{error}</Text>;
    }
    if (playbooks.length === 0) {
        return (
            <Box flexDirection="column">
                <Text color={theme.fgFaint}>no playbooks registered</Text>
                <Box marginTop={1}>
                    <Text color={theme.fgDim} wrap="wrap">
                        Upload from CLI:{' '}
                        <Text color={theme.accent}>
                            thinr product playbook upload &lt;product&gt; &lt;name&gt; &lt;file&gt;
                        </Text>
                    </Text>
                </Box>
            </Box>
        );
    }
    return (
        <Box flexDirection="column">
            {playbooks.map((pb, i) => {
                const isSel = i === selectedIdx;
                const mark = focused && isSel ? '▶' : isSel ? '›' : ' ';
                return (
                    <Box key={pb.name}>
                        <Box width={2}>
                            <Text color={isSel ? theme.accent : theme.fgFaint}>{mark}</Text>
                        </Box>
                        <Box flexDirection="column" flexGrow={1}>
                            <Text color={isSel ? theme.fg : theme.fgDim} bold={isSel}>
                                {pb.name}
                            </Text>
                            {pb.description && (
                                <Text color={theme.fgFaint} wrap="truncate-end">
                                    {pb.description}
                                </Text>
                            )}
                        </Box>
                    </Box>
                );
            })}
        </Box>
    );
}

function YamlView({ detail, scrollOffset, maxLines }) {
    if (!detail) {
        return <Text color={theme.fgFaint}>select a playbook to view</Text>;
    }
    if (detail.loading) {
        return <Text color={theme.fgDim}>loading YAML…</Text>;
    }
    if (detail.error) {
        return <Text color={theme.red}>{detail.error}</Text>;
    }
    const lines = (detail.yaml || '').split('\n');
    const view = lines.slice(scrollOffset, scrollOffset + Math.max(maxLines || 40, 4));
    return (
        <Box flexDirection="column">
            {detail.parseError && (
                <Box marginBottom={1}>
                    <Text color={theme.amber}>YAML parse error: {detail.parseError}</Text>
                </Box>
            )}
            {view.map((ln, i) => (
                <Text key={i} color={theme.fg} wrap="truncate-end">
                    <Text color={theme.fgFaint}>
                        {String(scrollOffset + i + 1).padStart(3)}{' '}
                    </Text>
                    {ln || ' '}
                </Text>
            ))}
            {lines.length > scrollOffset + (maxLines || 40) && (
                <Text color={theme.fgFaint}>
                    …{lines.length - (scrollOffset + (maxLines || 40))} more lines
                </Text>
            )}
        </Box>
    );
}

function ReportsList({ reports, selectedIdx, focused, error }) {
    if (error) {
        return <Text color={theme.amber}>{error}</Text>;
    }
    if (reports.length === 0) {
        return <Text color={theme.fgFaint}>no past runs</Text>;
    }
    return (
        <Box flexDirection="column">
            {reports.slice(0, 20).map((r, i) => {
                const isSel = focused && i === selectedIdx;
                return (
                    <Box key={r.path}>
                        <Box width={2}>
                            <Text color={isSel ? theme.accent : theme.fgFaint}>
                                {isSel ? '▶' : ' '}
                            </Text>
                        </Box>
                        <Box flexGrow={1}>
                            <Text color={isSel ? theme.fg : theme.fgDim} wrap="truncate-end">
                                {r.name.replace(/\.json$/, '')}
                            </Text>
                        </Box>
                    </Box>
                );
            })}
            {reports.length > 20 && (
                <Text color={theme.fgFaint}>…{reports.length - 20} older</Text>
            )}
        </Box>
    );
}

function deriveProducts(devices) {
    const set = new Set();
    for (const d of devices || []) {
        if (d?.product) set.add(d.product);
    }
    return [...set].sort();
}

export function PlaybooksTab({
    devices,
    defaultProductId,
    focused,
    onModalActiveChange,
}) {
    const { stdout } = useStdout();
    const rows = stdout?.rows || 24;

    const productOptions = useMemo(() => {
        const list = deriveProducts(devices);
        if (defaultProductId && !list.includes(defaultProductId)) list.unshift(defaultProductId);
        return list;
    }, [devices, defaultProductId]);

    const [productIdx, setProductIdx] = useState(0);
    const productId =
        productOptions[productIdx] || productOptions[0] || defaultProductId || null;

    const {
        playbooks,
        listError,
        loading,
        detail,
        reports,
        reportsError,
        reportDetail,
        loadDetail,
        clearDetail,
        loadReports,
        loadReport,
        clearReport,
        remove,
        refresh,
    } = useProductPlaybooks(productId);

    const run = usePlaybookRunController();

    const [selectedIdx, setSelectedIdx] = useState(0);
    const [reportIdx, setReportIdx] = useState(0);
    const [innerFocus, setInnerFocus] = useState('list');
    const [scroll, setScroll] = useState(0);
    const [notice, setNotice] = useState(null);
    // Device picker mode — `test`: after pick, seed the vars modal; the run
    // controller keeps the rest of the state machine.
    const [devicePicker, setDevicePicker] = useState(null);

    const selected = playbooks[selectedIdx];

    useEffect(() => {
        if (!selected) {
            clearDetail();
            setReportIdx(0);
            setScroll(0);
            return;
        }
        loadDetail(selected.name);
        loadReports(selected.name);
        setReportIdx(0);
        setScroll(0);
    }, [selected?.name, productId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (selectedIdx >= playbooks.length) {
            setSelectedIdx(Math.max(0, playbooks.length - 1));
        }
    }, [playbooks, selectedIdx]);

    const runPhase = run.state.phase;
    const overlayActive =
        runPhase === 'vars' ||
        runPhase === 'running' ||
        runPhase === 'done' ||
        runPhase === 'confirming-delete' ||
        !!devicePicker ||
        !!reportDetail;

    useEffect(() => {
        onModalActiveChange?.(overlayActive && focused);
    }, [overlayActive, focused, onModalActiveChange]);

    // Top-level input for the tab: list navigation + action shortcuts.
    useInput(
        (input, key) => {
            if (!focused) return;
            if (overlayActive) return; // modals own input

            if (key.tab) {
                const dir = key.shift ? -1 : 1;
                const i = PANELS.indexOf(innerFocus);
                setInnerFocus(PANELS[(i + dir + PANELS.length) % PANELS.length]);
                return;
            }
            if (input === 'p' && productOptions.length > 1) {
                setProductIdx((i) => (i + 1) % productOptions.length);
                setSelectedIdx(0);
                return;
            }
            if (input === 'r') {
                refresh();
                if (selected) loadReports(selected.name);
                return;
            }

            if (innerFocus === 'list') {
                if (key.upArrow) {
                    setSelectedIdx((i) => Math.max(0, i - 1));
                    return;
                }
                if (key.downArrow) {
                    setSelectedIdx((i) => Math.min(playbooks.length - 1, i + 1));
                    return;
                }
            } else if (innerFocus === 'detail') {
                if (key.upArrow) {
                    setScroll((s) => Math.max(0, s - 1));
                    return;
                }
                if (key.downArrow) {
                    setScroll((s) => s + 1);
                    return;
                }
                if (input === 'g') {
                    setScroll(0);
                    return;
                }
            } else if (innerFocus === 'reports') {
                if (key.upArrow) {
                    setReportIdx((i) => Math.max(0, i - 1));
                    return;
                }
                if (key.downArrow) {
                    setReportIdx((i) => Math.min(reports.length - 1, i + 1));
                    return;
                }
                if (key.return) {
                    const r = reports[reportIdx];
                    if (r) loadReport(r.path);
                    return;
                }
            }

            if (!selected) return;
            if (input === 't') {
                if (!detail?.parsed) {
                    setNotice('Playbook YAML not ready — open it first.');
                    return;
                }
                setDevicePicker({ mode: 'test' });
                return;
            }
            if (input === 'a') {
                if (!detail?.parsed) {
                    setNotice('Playbook YAML not ready — open it first.');
                    return;
                }
                run.startFleetVars(selected, detail.parsed);
                return;
            }
            if (input === 'x') {
                run.openDeleteConfirm(selected);
                return;
            }
        },
        { isActive: focused },
    );

    // Report detail overlay input (simple esc-to-close).
    useInput(
        (input, key) => {
            if (!focused) return;
            if (!reportDetail) return;
            if (runPhase !== 'idle') return;
            if (key.escape) clearReport();
        },
        { isActive: focused && !!reportDetail && runPhase === 'idle' },
    );

    // Running-phase input (abort only).
    useInput(
        (input, key) => {
            if (runPhase !== 'running') return;
            if (key.escape) run.cancelRunning();
        },
        { isActive: focused && runPhase === 'running' },
    );

    const handleRunDoneClose = () => {
        if (runPhase !== 'done') return;
        run.dismissDone();
        refresh();
        if (selected) loadReports(selected.name);
    };

    const selectedReport = reports[reportIdx] || null;

    const title = productId ? `PLAYBOOKS · ${productId}` : 'PLAYBOOKS';

    const right = (
        <Box>
            {productOptions.length > 1 && (
                <>
                    <Text color={theme.fgFaint}>
                        {productIdx + 1}/{productOptions.length}{'  '}
                    </Text>
                    <Text color={theme.magenta}>p</Text>
                    <Text color={theme.fgDim}> product</Text>
                </>
            )}
        </Box>
    );

    const yamlMaxLines = Math.max(6, rows - 10);

    // Fleet device collection at submit time. Using live state from
    // `devices` keeps offline filtering consistent with what the tab
    // surface shows and avoids a second round-trip.
    const collectFleetTargets = (includeOffline) => {
        const sameProduct = (devices || []).filter((d) => d.product === productId);
        return includeOffline ? sameProduct : filterActiveDevices(sameProduct);
    };

    return (
        <Box flexGrow={1}>
            <Box width="28%" flexDirection="column">
                <Panel
                    title={title}
                    sub={`${playbooks.length}`}
                    right={right}
                    focused={innerFocus === 'list'}
                    flexGrow={1}
                >
                    {!productId ? (
                        <Text color={theme.fgFaint}>
                            no product available — devices report no product binding
                        </Text>
                    ) : (
                        <PlaybookList
                            playbooks={playbooks}
                            loading={loading}
                            error={listError}
                            selectedIdx={selectedIdx}
                            focused={innerFocus === 'list'}
                        />
                    )}
                </Panel>
                {notice && (
                    <Box>
                        <Text color={theme.amber} wrap="wrap">
                            {notice}
                        </Text>
                    </Box>
                )}
            </Box>

            <Box width="44%" flexDirection="column">
                {runPhase === 'running' || runPhase === 'done' ? (
                    <PlaybookRunView
                        state={run.state}
                        focused={focused}
                        onClose={handleRunDoneClose}
                        maxOutputLines={Math.max(6, rows - 18)}
                    />
                ) : (
                    <Panel
                        title="YAML"
                        sub={selected ? selected.name : ''}
                        focused={innerFocus === 'detail'}
                        right={
                            <Box>
                                <Text color={theme.magenta}>t</Text>
                                <Text color={theme.fgDim}> test  </Text>
                                <Text color={theme.magenta}>a</Text>
                                <Text color={theme.fgDim}> apply  </Text>
                                <Text color={theme.magenta}>x</Text>
                                <Text color={theme.fgDim}> del</Text>
                            </Box>
                        }
                        flexGrow={1}
                    >
                        <YamlView detail={detail} scrollOffset={scroll} maxLines={yamlMaxLines} />
                    </Panel>
                )}
            </Box>

            <Box width="28%" flexDirection="column">
                <Panel
                    title="PAST RUNS"
                    sub={selected?.name || ''}
                    focused={innerFocus === 'reports'}
                    flexGrow={1}
                >
                    {reportDetail ? (
                        <>
                            <PlaybookReportView detail={reportDetail} />
                            <Box marginTop={1}>
                                <Text color={theme.fgDim}>esc back</Text>
                            </Box>
                        </>
                    ) : (
                        <>
                            <ReportsList
                                reports={reports}
                                selectedIdx={reportIdx}
                                focused={innerFocus === 'reports'}
                                error={reportsError}
                            />
                            {selectedReport && innerFocus === 'reports' && (
                                <Box marginTop={1}>
                                    <Text color={theme.fgDim} wrap="truncate-end">
                                        enter open · {selectedReport.path}
                                    </Text>
                                </Box>
                            )}
                        </>
                    )}
                </Panel>
            </Box>

            {devicePicker && (
                <Box
                    position="absolute"
                    width={stdout?.columns}
                    height={stdout?.rows}
                    alignItems="center"
                    justifyContent="center"
                >
                    <DevicePickerModal
                        title="TEST ON DEVICE"
                        devices={(devices || []).filter((d) => d.product === productId)}
                        onCancel={() => setDevicePicker(null)}
                        onSelect={(device) => {
                            setDevicePicker(null);
                            if (selected && detail?.parsed) {
                                run.startSingleVars(selected, detail.parsed, device);
                            }
                        }}
                    />
                </Box>
            )}

            {runPhase === 'vars' && (
                <Box
                    position="absolute"
                    width={stdout?.columns}
                    height={stdout?.rows}
                    alignItems="center"
                    justifyContent="center"
                >
                    <PlaybookVarsModal
                        playbookName={run.state.playbook?.name || ''}
                        mode={run.state.mode}
                        variables={run.state.parsed?.variables || []}
                        device={run.state.device}
                        deviceCount={
                            run.state.mode === 'fleet'
                                ? collectFleetTargets(false).length
                                : undefined
                        }
                        batchSize={run.state.batchSize}
                        failureThreshold={run.state.failureThreshold}
                        includeOffline={run.state.includeOffline}
                        onCancel={() => run.cancelFlow()}
                        onSubmit={async ({
                            overrides,
                            batchSize,
                            failureThreshold,
                            includeOffline,
                        }) => {
                            if (run.state.mode === 'fleet') {
                                const targets = collectFleetTargets(includeOffline);
                                if (targets.length === 0) {
                                    setNotice(
                                        includeOffline
                                            ? 'No devices bound to this product.'
                                            : 'No active devices — enable include-offline to target offline too.',
                                    );
                                    run.cancelFlow();
                                    return;
                                }
                                await run.runFleet({
                                    productId,
                                    playbook: run.state.playbook,
                                    parsed: run.state.parsed,
                                    devices: targets,
                                    overrides,
                                    batchSize,
                                    failureThreshold,
                                    includeOffline,
                                });
                            } else {
                                await run.runSingle({
                                    productId,
                                    playbook: run.state.playbook,
                                    parsed: run.state.parsed,
                                    device: run.state.device,
                                    overrides,
                                });
                            }
                        }}
                    />
                </Box>
            )}

            {runPhase === 'confirming-delete' && (
                <Box
                    position="absolute"
                    width={stdout?.columns}
                    height={stdout?.rows}
                    alignItems="center"
                    justifyContent="center"
                >
                    <ConfirmModal
                        title={`DELETE PLAYBOOK "${run.state.playbook?.name || ''}"`}
                        body={[
                            `Remove "${run.state.playbook?.name}" from product "${productId}"?`,
                            'The YAML file and the index entry will be deleted.',
                        ]}
                        confirmLabel="delete"
                        tone="danger"
                        onCancel={() => run.cancelFlow()}
                        onConfirm={async () => {
                            const target = run.state.playbook;
                            run.cancelFlow();
                            const res = await remove(target.name);
                            if (!res.ok) {
                                setNotice(`delete failed: ${res.error}`);
                                return;
                            }
                            setNotice(`deleted "${target.name}"`);
                            refresh();
                        }}
                    />
                </Box>
            )}
        </Box>
    );
}
