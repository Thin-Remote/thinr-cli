// @ts-check
import { confirm } from '@inquirer/prompts';
import { getDevices } from '../../lib/devices.js';
import { getMonitoringData } from '../../lib/monitoring.js';
import { fetchLatestAgentVersion } from '../../lib/agent-releases.js';
import { runFleetUpgrade, summarize } from '../../lib/fleet-upgrade.js';
import { classifyAgainst, normalizeAgentVersion } from '../../lib/agent-versions.js';
import {
    isJsonMode,
    printOk,
    printErr,
    createSpinner,
    classifyError,
} from '../../lib/output.js';
import {
    success,
    error as errorStyle,
    warning,
    hint,
    label,
    muted,
    accent,
} from '../../lib/format.js';
import {
    applyJsonFlag,
    ensureConfigured,
    getGlobalUser,
    parsePositiveInt,
} from '../_shared.js';

export function registerUpgradeCommand(fleet) {
    fleet
        .command('upgrade')
        .helpGroup('Fleet:')
        .description('Apply an agent update across every outdated device in the fleet')
        .option('-j, --json', 'Output as JSON')
        .option('--channel <name>', 'Release channel to target', 'latest')
        .option('-p, --product <id>', 'Restrict to devices belonging to this product')
        .option('-g, --group <id>', 'Restrict to devices in this asset group')
        .option(
            '--batch-size <n>',
            'Devices updated in parallel once the canary passes',
            parsePositiveInt('batch-size'),
            5,
        )
        .option('--no-canary', 'Skip the canary phase (upgrade everything in batches from the start)')
        .option('--continue-on-error', 'Keep rolling after a batch failure instead of aborting')
        .option('--dry-run', 'List what would be upgraded without sending any update request')
        .option('-y, --yes', 'Skip the confirmation prompt (required in non-interactive shells)')
        .action(async (opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            // ── 1. Target version ──────────────────────────────────────
            const latestSpinner = createSpinner(
                `Resolving ${opts.channel} release…`,
            ).start();
            let target;
            try {
                target = await fetchLatestAgentVersion({ channel: opts.channel });
                latestSpinner.succeed(`Channel ${accent(opts.channel)} → ${success(target)}`);
            } catch (err) {
                latestSpinner.fail(`Failed to resolve channel ${opts.channel}`);
                const { message, code } = classifyError(err);
                printErr(message, { code });
                return;
            }

            // ── 2. Fleet inventory ─────────────────────────────────────
            const listSpinner = createSpinner('Listing fleet…').start();
            let devices;
            try {
                const filter = {};
                if (opts.product) filter.product = opts.product;
                if (opts.group) filter.asset_group = opts.group;
                devices = await getDevices(filter, user);
                listSpinner.succeed(`Fleet size: ${label(devices.length)} device(s)`);
            } catch (err) {
                listSpinner.fail('Failed to list devices');
                const { message, code } = classifyError(err);
                printErr(message, { code });
                return;
            }
            if (devices.length === 0) {
                if (isJsonMode()) {
                    printOk({ target, outdated: [], results: [] });
                } else {
                    console.log(hint('No devices match the filter.'));
                }
                return;
            }

            // ── 3. Current versions ────────────────────────────────────
            // Fleet-wide monitoring snapshot trimmed to `agent.version`.
            // The backend may return several rows per device (history
            // tail); with `sort=desc` the first row we see per device is
            // the most recent one, so we ignore later repeats. We also
            // scope to the filtered fleet so monitoring data from devices
            // outside the product/group filter doesn't leak into the count.
            const versionsSpinner = createSpinner('Reading agent versions…').start();
            const fleetIds = new Set(devices.map((d) => d.device));
            const deviceVersions = {};
            for (const d of devices) deviceVersions[d.device] = null;
            try {
                const rows = await getMonitoringData({
                    user,
                    items: Math.max(500, devices.length),
                    sort: 'desc',
                    fields: 'agent.version',
                });
                if (Array.isArray(rows)) {
                    for (const row of rows) {
                        const id = row?.device;
                        const v = row?.agent?.version;
                        if (!id || !v || !fleetIds.has(id)) continue;
                        if (deviceVersions[id]) continue;
                        deviceVersions[id] = v;
                    }
                }
                const known = Object.values(deviceVersions).filter(Boolean).length;
                versionsSpinner.succeed(`Read versions for ${label(known)} of ${devices.length} device(s)`);
            } catch (err) {
                versionsSpinner.fail('Failed to read monitoring data');
                const { message, code } = classifyError(err);
                printErr(message, { code });
                return;
            }

            const { outdated, current, unknown } = classifyAgainst(target, deviceVersions);

            // ── 4. Render summary ──────────────────────────────────────
            const versionCounts = countVersions(deviceVersions);
            if (!isJsonMode()) {
                console.log();
                console.log(label('Agent versions in fleet:'));
                for (const [v, c] of versionCounts) {
                    const tag = v === target ? success('●') : warning('●');
                    console.log(`  ${tag} ${v.padEnd(12)} ${muted(String(c))}`);
                }
                if (unknown.length) {
                    console.log(`  ${muted('?')} ${'unknown'.padEnd(12)} ${muted(String(unknown.length))}`);
                }
                console.log();
                console.log(
                    `Target: ${success(target)}  ·  ` +
                        `outdated: ${label(outdated.length)}  ·  ` +
                        `current: ${muted(current.length)}` +
                        (unknown.length ? `  ·  unknown: ${muted(unknown.length)}` : ''),
                );
                console.log();
            }

            if (outdated.length === 0) {
                if (isJsonMode()) {
                    printOk({
                        target,
                        summary: { outdated: 0, current: current.length, unknown: unknown.length },
                        results: [],
                    });
                } else {
                    console.log(success('All devices are already on the target version.'));
                }
                return;
            }

            // ── 5. Dry-run ─────────────────────────────────────────────
            if (opts.dryRun) {
                if (isJsonMode()) {
                    printOk({
                        target,
                        dryRun: true,
                        outdated,
                        current,
                        unknown,
                    });
                    return;
                }
                console.log(label(`Would upgrade ${outdated.length} device(s):`));
                for (const id of outdated) {
                    console.log(`  - ${id} ${muted(`(${normalizeAgentVersion(deviceVersions[id]) || '?'})`)}`);
                }
                return;
            }

            // ── 6. Confirmation ────────────────────────────────────────
            if (!opts.yes && !isJsonMode()) {
                if (!process.stdin.isTTY) {
                    printErr(
                        'Refusing to upgrade without --yes in a non-interactive shell',
                        { code: 'needs_confirm' },
                    );
                    return;
                }
                const plan = opts.canary ? 'canary first, then batches' : 'all in batches';
                const failure = opts.continueOnError ? 'continue on failure' : 'abort on failure';
                const ok = await confirm({
                    message: `Upgrade ${outdated.length} device(s) to ${target}? (${plan} · ${failure})`,
                    default: false,
                });
                if (!ok) {
                    console.log(hint('Cancelled.'));
                    return;
                }
            }

            // ── 7. Rollout ─────────────────────────────────────────────
            const runSpinner = createSpinner('').start();
            const setRunText = (done, total) => {
                runSpinner.text = `Upgrading · ${done}/${total} device(s) processed`;
            };
            setRunText(0, outdated.length);

            const perDevice = [];
            const { results, aborted, reason } = await runFleetUpgrade({
                deviceIds: outdated,
                channel: opts.channel,
                user,
                canary: opts.canary,
                abortOnFailure: !opts.continueOnError,
                batchSize: opts.batchSize,
                onProgress: ({ done, total }) => setRunText(done, total),
                onDeviceResult: (r) => {
                    perDevice.push(r);
                },
            });
            runSpinner.stop();

            // ── 8. Results ─────────────────────────────────────────────
            const sum = summarize(results);
            if (isJsonMode()) {
                printOk({
                    target,
                    channel: opts.channel,
                    aborted,
                    reason: aborted ? reason : undefined,
                    summary: sum,
                    results,
                });
                return;
            }

            for (const r of results) {
                if (r.ok) {
                    console.log(`  ${success('✓')} ${r.deviceId}`);
                } else {
                    console.log(`  ${errorStyle('✗')} ${r.deviceId}  ${muted(r.error)}`);
                }
            }

            console.log();
            const verdict = aborted
                ? `${warning('aborted')} (${reason}) · ${sum.ok} ok · ${sum.failed} failed`
                : `${success('done')} · ${sum.ok} ok · ${sum.failed} failed`;
            console.log(label(`Rollout ${verdict}`));

            if (aborted || sum.failed > 0) {
                // Scripts can use the exit code to gate follow-up work — a
                // partial rollout is a "soft failure" worth surfacing.
                process.exitCode = 1;
            }
        });
}

function countVersions(deviceVersions) {
    const counts = new Map();
    for (const raw of Object.values(deviceVersions)) {
        const v = normalizeAgentVersion(raw);
        if (!v) continue;
        counts.set(v, (counts.get(v) || 0) + 1);
    }
    // Newest first by semver — reuse the comparator via dynamic import
    // would be overkill here; the caller only needs a stable human order.
    return [...counts.entries()].sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true }));
}
