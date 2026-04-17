// @ts-check
import { dirname, resolve } from 'path';
import Table from 'cli-table3';
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
        .option('--dry-run', 'Print the plan without executing anything')
        .option('--target <product>', 'Override the target product declared in the file')
        .option('--group <group>', 'Override the asset group filter')
        .option(
            '-c, --concurrency <n>',
            'Override max parallel devices',
            parsePositiveInt('concurrency'),
        )
        .option('--fail-fast', 'Stop dequeueing new devices on the first failure')
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
            const updateSpinner = () => {
                runSpinner.text = `Executing · ${done}/${devices.length} device(s) finished`;
            };
            updateSpinner();

            const results = await runPlaybook(pb, devices, {
                user,
                concurrency: pb.target.concurrency,
                failFast: pb.target.fail_fast,
                baseDir: dirname(resolve(file)),
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
            if (isJsonMode()) {
                const okCount = results.filter((r) => r.ok).length;
                printOk({
                    name: pb.name,
                    target: pb.target,
                    summary: {
                        total: results.length,
                        ok: okCount,
                        failed: results.length - okCount,
                    },
                    results,
                });
                return;
            }

            const table = new Table({
                head: ['Device', 'Status', 'Failed step', 'Duration'].map((h) => label(h)),
                style: { head: [], border: ['gray'] },
                colAligns: ['left', 'left', 'left', 'right'],
            });
            for (const r of results) {
                const firstFail = r.steps.find((s) => !s.ok && !s.skipped);
                const statusCell = r.ok ? success('ok') : errorStyle('fail');
                const failCell = firstFail
                    ? `${firstFail.name} · ${muted(firstFail.summary)}`
                    : muted('—');
                let durationMs = 0;
                for (const s of r.steps) durationMs += s.durationMs || 0;
                table.push([r.device, statusCell, failCell, `${durationMs}ms`]);
            }
            console.log(table.toString());
            const okCount = results.filter((r) => r.ok).length;
            console.log(
                hint(
                    `${results.length} total · ${okCount} ok · ${results.length - okCount} failed`,
                ),
            );
        });
}
