// @ts-check
import { dirname, resolve } from 'path';
import { loadPlaybookFile } from '../../lib/playbook/loader.js';
import { buildDryRunPlan, resolveTargets, runPlaybook } from '../../lib/playbook/runner.js';
import {
    isJsonMode,
    printOk,
    printErr,
    createSpinner,
    classifyError,
} from '../../lib/output.js';
import { success, error as errorStyle, warning, hint, label, muted } from '../../lib/format.js';
import {
    applyJsonFlag,
    ensureConfigured,
    getGlobalUser,
    parsePositiveInt,
    collectVar,
} from './_shared.js';

export function registerRunCommand(playbook) {
    playbook
        .command('run <file>')
        .helpGroup('Playbook:')
        .description('Run a playbook against the product / devices declared in its target block')
        .option('-j, --json', 'Output as JSON')
        .option('--dry-run', 'Print the static plan without contacting devices')
        .option('--check', 'Contact devices read-only and report what would change (no writes)')
        .option('--target <product>', 'Override the target product declared in the file')
        .option('--group <group>', 'Override the asset group filter')
        .option(
            '-c, --concurrency <n>',
            'Override max parallel devices',
            parsePositiveInt('concurrency'),
        )
        .option('--fail-fast', 'Stop dequeueing new devices on the first failure')
        .option('--continue-on-error', 'Keep running subsequent steps on a device even if one fails')
        .option('-v, --var <key=value>', 'Override a playbook variable (repeatable)', collectVar, {})
        .action(async (file, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            let pb;
            try {
                pb = loadPlaybookFile(file);
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code: code === 'error' ? 'input_error' : code });
                return;
            }

            // CLI overrides merge into the parsed document before we
            // resolve targets, so overrides affect device selection too.
            if (opts.target) pb.target.product = opts.target;
            if (opts.group) pb.target.group = opts.group;
            if (opts.concurrency) pb.target.concurrency = opts.concurrency;
            if (opts.failFast) pb.target.fail_fast = true;
            if (opts.var && Object.keys(opts.var).length) {
                pb.vars = { ...pb.vars, ...opts.var };
            }

            // ── Dry-run path ──────────────────────────────────────────
            if (opts.dryRun) {
                const plan = buildDryRunPlan(pb);
                if (isJsonMode()) {
                    printOk({
                        name: pb.name,
                        target: pb.target,
                        vars: pb.vars,
                        steps: plan,
                    });
                    return;
                }
                if (pb.name) console.log(label(pb.name));
                console.log(
                    hint(
                        `target: ${pb.target.product || '(explicit)'}` +
                            (pb.target.group ? ` · group=${pb.target.group}` : '') +
                            ` · concurrency=${pb.target.concurrency}` +
                            (pb.target.fail_fast ? ' · fail-fast' : ''),
                    ),
                );
                console.log(label(`\nPlan (${plan.length} step${plan.length === 1 ? '' : 's'}):`));
                for (const s of plan) {
                    const pause = s.pause_after ? muted(`  then pause ${s.pause_after}s`) : '';
                    console.log(
                        `  ${hint(String(s.index + 1).padStart(2) + '.')} ` +
                            `${label(s.name)}  ${muted(`(${s.action})`)}${pause}`,
                    );
                }
                return;
            }

            // ── Resolve targets ──────────────────────────────────────
            const resolveSpinner = createSpinner('Resolving targets...').start();
            let devices;
            try {
                devices = await resolveTargets(pb, { user });
                resolveSpinner.succeed(`Running on ${devices.length} device(s)`);
            } catch (err) {
                resolveSpinner.fail('Failed to resolve targets');
                const { message, code } = classifyError(err);
                printErr(message, { code });
                return;
            }

            if (devices.length === 0) {
                if (isJsonMode()) {
                    printOk({ name: pb.name, devices: [], results: [] });
                } else {
                    console.log(warning('No devices to run on.'));
                }
                return;
            }

            // ── Execute ──────────────────────────────────────────────
            const runSpinner = createSpinner('').start();
            let done = 0;
            const verb = opts.check ? 'Checking' : 'Executing';
            const updateSpinner = () => {
                runSpinner.text = `${verb} · ${done}/${devices.length} device(s) finished`;
            };
            updateSpinner();

            const results = await runPlaybook(pb, devices, {
                user,
                concurrency: pb.target.concurrency,
                failFast: pb.target.fail_fast,
                baseDir: dirname(resolve(file)),
                checkMode: !!opts.check,
                continueOnError: !!opts.continueOnError,
                onStepEnd: () => {
                    // bump the spinner whenever any device finishes its
                    // last step. Cheaper than a per-step counter when
                    // devices are running in parallel.
                },
            });
            // Count devices whose outcome is known (all settled).
            done = results.length;
            runSpinner.stop();

            // ── Render ───────────────────────────────────────────────
            const verdictTotals = aggregateVerdicts(results);

            if (isJsonMode()) {
                const okCount = results.filter((r) => r.ok).length;
                printOk({
                    name: pb.name,
                    target: pb.target,
                    mode: opts.check ? 'check' : 'apply',
                    summary: {
                        total: results.length,
                        ok: okCount,
                        failed: results.length - okCount,
                        ...(opts.check ? { verdicts: verdictTotals } : {}),
                    },
                    results,
                });
                return;
            }

            const devicesWithFailures = [];
            const deviceColWidth = Math.max(
                ...results.map((r) => r.device.length),
                12,
            );
            for (const r of results) {
                const fails = r.steps.filter((s) => !s.ok && !s.skipped);
                const statusTag = r.ok ? success('success') : errorStyle('failed ');
                let durationMs = 0;
                for (const s of r.steps) durationMs += s.durationMs || 0;
                const duration = muted(`${durationMs}ms`.padStart(6));
                const counts = opts.check
                    ? perDeviceCheckCounts(r)
                    : perDeviceApplyCounts(r);
                let extra = '';
                if (fails.length === 1) {
                    extra = `  ${fails[0].name} · ${muted(fails[0].summary)}`;
                } else if (fails.length > 1) {
                    devicesWithFailures.push({ device: r.device, fails });
                }
                console.log(
                    `  ${statusTag}  ${r.device.padEnd(deviceColWidth)}  ${duration}  ${counts}${extra}`,
                );
            }
            const okCount = results.filter((r) => r.ok).length;
            console.log(
                hint(
                    `${results.length} total · ${okCount} ok · ${results.length - okCount} failed`,
                ),
            );
            // Always surface per-step failure detail when any device had
            // multiple failures (continue-on-error path) or we want to
            // group by step for a quick "which steps broke, on which
            // devices" view.
            if (devicesWithFailures.length) {
                const failedStepIndices = new Set();
                for (const r of results) {
                    for (const s of r.steps) {
                        if (!s.ok && !s.skipped) failedStepIndices.add(s.index);
                    }
                }
                const sortedIndices = [...failedStepIndices].sort((a, b) => a - b);
                console.log(label('\nFailed steps:'));
                for (const idx of sortedIndices) {
                    const header = `${String(idx + 1).padStart(2)}. ${pb.steps[idx].name}`;
                    console.log(`  ${label(header)}`);
                    for (const r of results) {
                        const s = r.steps.find((x) => x.index === idx);
                        if (!s || s.ok || s.skipped) continue;
                        console.log(
                            `    ${errorStyle('!')} ${r.device.padEnd(20)} ${muted(s.summary)}`,
                        );
                    }
                }
            }
            if (opts.check) {
                console.log(label('\nCheck details:'));
                const stepCount = pb.steps.length;
                for (let idx = 0; idx < stepCount; idx++) {
                    const header = `${String(idx + 1).padStart(2)}. ${pb.steps[idx].name}`;
                    console.log(`  ${label(header)}`);
                    for (const r of results) {
                        const s = r.steps.find((x) => x.index === idx);
                        if (!s) continue;
                        const tag = verdictTag(s);
                        console.log(
                            `    ${tag} ${r.device.padEnd(20)} ${muted(s.summary)}`,
                        );
                    }
                }
                console.log(
                    hint(
                        `\nSummary: +${verdictTotals.changed}  ` +
                            `=${verdictTotals.unchanged}  ` +
                            `?${verdictTotals.unknown}`,
                    ),
                );
            }
        });
}

function perDeviceCheckCounts(r) {
    const counts = { changed: 0, unchanged: 0, unknown: 0, failed: 0, skipped: 0 };
    for (const s of r.steps) {
        if (!s.ok) counts.failed += 1;
        else if (s.skipped) counts.skipped += 1;
        else if (s.verdict && s.verdict in counts) counts[s.verdict] += 1;
    }
    const parts = [
        `${warning('+' + counts.changed)}`,
        `${muted('=' + counts.unchanged)}`,
        `${hint('?' + counts.unknown)}`,
    ];
    if (counts.failed) parts.push(errorStyle(`!${counts.failed}`));
    if (counts.skipped) parts.push(muted(`·${counts.skipped}`));
    return parts.join('  ');
}

function perDeviceApplyCounts(r) {
    let changed = 0;
    let unchanged = 0;
    let failed = 0;
    let skipped = 0;
    for (const s of r.steps) {
        if (!s.ok) failed += 1;
        else if (s.skipped) skipped += 1;
        else if (s.verdict === 'unchanged') unchanged += 1;
        else changed += 1;
    }
    const parts = [warning(`+${changed}`), muted(`=${unchanged}`)];
    if (failed) parts.push(errorStyle(`!${failed}`));
    if (skipped) parts.push(muted(`·${skipped}`));
    return parts.join('  ');
}

function aggregateVerdicts(results) {
    const totals = { changed: 0, unchanged: 0, unknown: 0 };
    for (const r of results) {
        for (const s of r.steps) {
            if (!s.verdict) continue;
            if (s.verdict in totals) totals[s.verdict] += 1;
        }
    }
    return totals;
}

function verdictTag(step) {
    if (!step.ok) return errorStyle('!');
    if (step.skipped) return muted('·');
    switch (step.verdict) {
        case 'changed':
            return warning('+');
        case 'unchanged':
            return muted('=');
        case 'unknown':
            return hint('?');
        default:
            return muted('·');
    }
}
