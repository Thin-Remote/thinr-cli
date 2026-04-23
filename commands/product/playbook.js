// @ts-check
import { readFileSync, writeFileSync } from 'fs';
import Table from 'cli-table3';
import YAML from 'yaml';
import { confirm } from '@inquirer/prompts';
import {
    deleteProductPlaybook,
    findProductPlaybook,
    listProductPlaybooks,
    readProductPlaybook,
    uploadFleetRunReport,
    uploadProductPlaybook,
} from '../../lib/product.js';
import { parsePlaybook } from '../../lib/playbook/loader.js';
import { buildDryRunPlan, runPlaybook } from '../../lib/playbook/runner.js';
import { DEFAULT_FAILURE_THRESHOLD, runFleetPlaybook } from '../../lib/playbook/fleet.js';
import { coerceCliVarValue, listVariables, resolveVarScope } from '../../lib/playbook/vars.js';
import { filterActiveDevices, getDevices } from '../../lib/devices.js';
import { requireConfig } from '../../lib/config.js';
import { inputError } from '../../lib/errors.js';
import {
    accent,
    error as errorStyle,
    hint,
    info,
    label,
    muted,
    success,
    warning,
} from '../../lib/format.js';
import { classifyError, createSpinner, isJsonMode, printErr, printOk } from '../../lib/output.js';
import {
    applyJsonFlag,
    collectKeyValue,
    ensureConfigured,
    getGlobalUser,
    parsePositiveInt,
} from '../_shared.js';

async function readAllStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

function registerList(playbook) {
    playbook
        .command('list <productId>')
        .helpGroup('Playbooks:')
        .description('List playbooks registered on a product')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            try {
                const entries = await listProductPlaybooks(productId, user);
                if (isJsonMode()) {
                    printOk({ product: productId, playbooks: entries });
                    return;
                }
                if (entries.length === 0) {
                    console.log(`No playbooks registered on ${info(productId)}`);
                    return;
                }
                const table = new Table({
                    head: ['Name', 'Description', 'Path'].map((h) => label(h)),
                    style: { head: [], border: ['gray'] },
                });
                for (const e of entries) {
                    table.push([e.name, e.description || muted('—'), muted(e.path)]);
                }
                console.log(`${entries.length} playbook(s) on ${info(productId)}:`);
                console.log(table.toString());
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });
}

function registerUpload(playbook) {
    playbook
        .command('upload <productId> <name> [file]')
        .helpGroup('Playbooks:')
        .description(
            'Upload a playbook YAML to a product (reads stdin when <file> is omitted or "-")',
        )
        .option('-d, --description <text>', 'Override the description recorded in the index')
        .option('--skip-validation', 'Skip playbook schema validation before uploading')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, name, file, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            let content;
            try {
                if (file && file !== '-') {
                    content = readFileSync(file, 'utf8');
                } else if (!process.stdin.isTTY) {
                    content = await readAllStdin();
                } else {
                    printErr(
                        'No playbook given. Pass a file path or pipe the YAML on stdin.',
                        { code: 'input_error' },
                    );
                    return;
                }
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code: code === 'error' ? 'input_error' : code });
                return;
            }

            const spinner = createSpinner(`Uploading playbook ${name} to ${productId}...`).start();
            try {
                const result = await uploadProductPlaybook({
                    product: productId,
                    name,
                    content,
                    description: opts.description,
                    user,
                    skipValidation: !!opts.skipValidation,
                });
                spinner.succeed(
                    `Playbook ${name} ${result.action} on ${productId}` +
                        (result.replaced ? ' (replaced existing entry)' : ''),
                );
                if (isJsonMode()) {
                    printOk({
                        product: productId,
                        action: result.action,
                        replaced: result.replaced,
                        entry: result.entry,
                        steps: result.steps,
                    });
                    return;
                }
                if (result.replaced) {
                    console.log(warning(`Replaced existing playbook "${name}".`));
                }
                for (const step of result.steps) console.log(`  ${muted('·')} ${step}`);
            } catch (err) {
                spinner.fail(`Failed to upload playbook ${name}`);
                const { message, code } = classifyError(err);
                printErr(message, { code: code === 'error' ? 'input_error' : code });
            }
        });
}

function registerDownload(playbook) {
    playbook
        .command('download <productId> <name>')
        .helpGroup('Playbooks:')
        .description('Download a playbook YAML by name (writes to stdout by default)')
        .option('-o, --output <file>', 'Write to a local file instead of stdout')
        .option('-j, --json', 'Output as JSON (wraps the YAML in the envelope)')
        .action(async (productId, name, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            try {
                const content = await readProductPlaybook(productId, name, user);
                if (opts.output) {
                    writeFileSync(opts.output, content, 'utf8');
                    if (isJsonMode()) {
                        printOk({
                            product: productId,
                            name,
                            bytes: Buffer.byteLength(content, 'utf8'),
                            output: opts.output,
                        });
                        return;
                    }
                    console.log(
                        success(`Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${opts.output}`),
                    );
                    return;
                }
                if (isJsonMode()) {
                    printOk({
                        product: productId,
                        name,
                        bytes: Buffer.byteLength(content, 'utf8'),
                        content,
                    });
                    return;
                }
                process.stdout.write(content);
                if (content && !content.endsWith('\n')) process.stdout.write('\n');
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });
}

function registerDelete(playbook) {
    playbook
        .command('delete <productId> <name>')
        .helpGroup('Playbooks:')
        .description('Delete a playbook from a product (idempotent)')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, name, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const spinner = createSpinner(`Deleting playbook ${name} from ${productId}...`).start();
            try {
                const result = await deleteProductPlaybook({ product: productId, name, user });
                if (result.removed) {
                    spinner.succeed(`Deleted playbook ${name} from ${productId}`);
                } else {
                    spinner.succeed(`Playbook ${name} was not registered on ${productId}`);
                }
                if (isJsonMode()) {
                    printOk({
                        product: productId,
                        name,
                        removed: result.removed,
                        indexRemoved: result.indexRemoved,
                        fileRemoved: result.fileRemoved,
                        steps: result.steps,
                    });
                    return;
                }
                for (const step of result.steps) console.log(`  ${muted('·')} ${step}`);
            } catch (err) {
                spinner.fail(`Failed to delete playbook ${name}`);
                const { message, code } = classifyError(err);
                printErr(message, { code: code === 'error' ? 'input_error' : code });
            }
        });
}

function loadVarsFile(filePath) {
    const raw = readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
        const parsed = YAML.parse(raw);
        if (parsed == null) return {};
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw inputError(
                `--vars-file "${filePath}" must contain a mapping of variable names to values.`,
            );
        }
        return parsed;
    } catch (err) {
        if (err.code === 'input_error') throw err;
        throw inputError(`Failed to parse --vars-file "${filePath}": ${err.message}`);
    }
}

function collectCliOverrides(pb, cliVarEntries, varsFilePath) {
    const merged = varsFilePath ? { ...loadVarsFile(varsFilePath) } : {};
    for (const [name, raw] of Object.entries(cliVarEntries || {})) {
        merged[name] = coerceCliVarValue(pb, name, raw);
    }
    return merged;
}

function renderStepResult(step, stepIndex) {
    const header = `${String(stepIndex + 1).padStart(2)}. ${step.name}`;
    if (step.skipped) {
        return `  ${muted('·')} ${label(header)}  ${muted(step.summary)}`;
    }
    if (!step.ok) {
        return `  ${errorStyle('!')} ${label(header)}  ${errorStyle(step.summary)}`;
    }
    const verdict = step.verdict;
    let tag = success('+');
    if (verdict === 'unchanged') tag = muted('=');
    else if (verdict === 'unknown') tag = hint('?');
    const duration = muted(` (${step.durationMs}ms)`);
    return `  ${tag} ${label(header)}  ${muted(step.summary)}${duration}`;
}

async function maybeConfirm({ productId, name, deviceId, steps, skipPrompt }) {
    if (skipPrompt) return true;
    if (isJsonMode()) return true;
    if (!process.stdin.isTTY) return true;
    const message = `${accent('Run')} playbook "${name}" on product "${productId}" against device "${deviceId}" (${steps} step${steps === 1 ? '' : 's'})?`;
    return confirm({ message, default: false });
}

async function maybeConfirmFleet({
    productId,
    name,
    steps,
    deviceCount,
    batchSize,
    failureThreshold,
    skipPrompt,
}) {
    if (skipPrompt) return true;
    if (isJsonMode()) return true;
    if (!process.stdin.isTTY) {
        throw inputError(
            'Fleet rollout requires interactive confirmation. Re-run with --yes in non-interactive shells.',
        );
    }
    const message =
        `${accent('Roll out')} "${name}" on product "${productId}" to ${deviceCount} device(s) ` +
        `in batches of ${batchSize} (abort at ${failureThreshold}% failure, ${steps} step${steps === 1 ? '' : 's'} each)?`;
    return confirm({ message, default: false });
}

async function collectFleetDevices({ productId, group, filters, includeOffline, user }) {
    const baseFilter = { product: productId };
    if (group) baseFilter.asset_group = group;
    for (const [k, v] of Object.entries(filters || {})) {
        if (!/^[A-Za-z0-9_]+$/.test(k)) {
            throw inputError(`Invalid filter key "${k}" (letters, digits, underscore only).`);
        }
        baseFilter[k] = v;
    }
    const all = await getDevices(baseFilter, user);
    return includeOffline ? all : filterActiveDevices(all);
}

function renderFleetResultTable(results) {
    const table = new Table({
        head: ['Device', 'Status', 'Steps', 'Error'].map((h) => label(h)),
        style: { head: [], border: ['gray'] },
    });
    for (const r of results) {
        const stepCount = Array.isArray(r?.steps) ? r.steps.length : 0;
        let status;
        if (r?.skipped) status = warning('SKIPPED');
        else if (r?.ok) status = success('OK');
        else status = errorStyle('FAILED');
        const err = r?.error ? muted(r.error) : muted('—');
        table.push([r?.device || '?', status, String(stepCount), err]);
    }
    return table.toString();
}

function buildRunReport({
    productId,
    name,
    playbook,
    user,
    startedAt,
    finishedAt,
    mode,
    batchSize,
    failureThreshold,
    filters,
    group,
    includeOffline,
    resolvedVars,
    summary,
    reason,
    results,
    batches,
}) {
    return {
        product: productId,
        name,
        user,
        startedAt,
        finishedAt,
        durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        mode,
        playbook: {
            name: playbook.name || null,
            description: playbook.description || null,
            steps: playbook.steps.length,
        },
        rollout: {
            batchSize,
            failureThreshold,
            filters: filters && Object.keys(filters).length > 0 ? filters : null,
            group: group || null,
            includeOffline: !!includeOffline,
        },
        vars: resolvedVars,
        summary,
        aborted: !!reason,
        reason: reason || null,
        batches,
        devices: results.map((r) => ({
            device: r?.device,
            ok: !!r?.ok,
            skipped: !!r?.skipped,
            error: r?.error || null,
            steps: Array.isArray(r?.steps)
                ? r.steps.map((s) => ({
                      index: s.index,
                      name: s.name,
                      ok: !!s.ok,
                      skipped: !!s.skipped,
                      verdict: s.verdict || null,
                      summary: s.summary,
                      durationMs: s.durationMs,
                      error: s.error || null,
                  }))
                : [],
        })),
    };
}

async function loadProductPlaybook({ productId, name, user }) {
    const entry = await findProductPlaybook(productId, name, user);
    if (!entry) {
        const available = (await listProductPlaybooks(productId, user))
            .map((e) => e.name)
            .join(', ') || '(none)';
        const err = new Error(
            `Playbook "${name}" is not registered on product "${productId}". Available: ${available}`,
        );
        err.code = 'not_found';
        throw err;
    }
    const content = await readProductPlaybook(productId, name, user);
    return parsePlaybook(content, { sourcePath: `${name}.yaml` });
}

async function runSingleDevice({ productId, name, pb, overrides, resolvedScope, user, opts }) {
    pb.target.devices = [opts.device];
    pb.target.product = productId;
    pb.target.group = null;

    if (opts.dryRun) {
        const plan = buildDryRunPlan(pb, { overrides });
        if (isJsonMode()) {
            printOk({
                product: productId,
                name,
                device: opts.device,
                variables: listVariables(pb),
                vars: resolvedScope,
                steps: plan,
            });
            return;
        }
        console.log(`${label(pb.name || name)} ${muted(`(dry-run · ${opts.device})`)}`);
        if (pb.description) console.log(muted(pb.description));
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

    const confirmed = await maybeConfirm({
        productId,
        name,
        deviceId: opts.device,
        steps: pb.steps.length,
        skipPrompt: !!opts.yes || !!opts.check,
    });
    if (!confirmed) {
        if (isJsonMode()) {
            printOk({ product: productId, name, device: opts.device, cancelled: true });
        } else {
            console.log(warning('Cancelled.'));
        }
        return;
    }

    const all = await getDevices({ product: productId }, user);
    const device =
        all.find((d) => d.device === opts.device) || {
            device: opts.device,
            connection: { active: false },
        };

    const verb = opts.check ? 'Checking' : 'Running';
    const spinner = createSpinner(`${verb} "${name}" on ${opts.device}...`).start();
    let results;
    try {
        results = await runPlaybook(pb, [device], {
            user,
            concurrency: 1,
            failFast: true,
            checkMode: !!opts.check,
            overrides,
        });
        spinner.stop();
    } catch (err) {
        spinner.fail(`${verb} failed`);
        throw err;
    }

    const result = results[0];
    if (isJsonMode()) {
        printOk({
            product: productId,
            name,
            device: opts.device,
            mode: opts.check ? 'check' : 'apply',
            ok: !!result?.ok,
            result,
        });
        return;
    }

    const titleTag = result?.ok ? success('OK') : errorStyle('FAILED');
    console.log(
        `${label(pb.name || name)} ${muted(`(${opts.check ? 'check' : 'apply'} · ${opts.device})`)}  ${titleTag}`,
    );
    if (Array.isArray(result?.steps)) {
        for (const step of result.steps) {
            console.log(renderStepResult(step, step.index));
        }
    }
    if (!result?.ok && result?.error) {
        console.log(errorStyle(`\n${result.error}`));
    }
}

async function runFleet({ productId, name, pb, overrides, resolvedScope, user, opts }) {
    const batchSize = opts.batchSize ?? 5;
    const failureThreshold =
        opts.failureThreshold === undefined
            ? DEFAULT_FAILURE_THRESHOLD
            : opts.failureThreshold;

    pb.target.devices = null;
    pb.target.product = productId;
    pb.target.group = opts.group || null;

    let devices;
    try {
        devices = await collectFleetDevices({
            productId,
            group: opts.group,
            filters: opts.filter,
            includeOffline: !!opts.includeOffline,
            user,
        });
    } catch (err) {
        throw err;
    }

    if (opts.dryRun) {
        const plan = buildDryRunPlan(pb, { overrides });
        if (isJsonMode()) {
            printOk({
                product: productId,
                name,
                fleet: true,
                mode: opts.check ? 'check' : 'apply',
                device_count: devices.length,
                devices: devices.map((d) => d.device),
                batch_size: batchSize,
                failure_threshold: failureThreshold,
                variables: listVariables(pb),
                vars: resolvedScope,
                steps: plan,
            });
            return;
        }
        console.log(
            `${label(pb.name || name)} ${muted(`(dry-run · fleet · ${devices.length} device(s))`)}`,
        );
        if (pb.description) console.log(muted(pb.description));
        console.log(
            muted(
                `Batch size: ${batchSize}  ·  Abort at ${failureThreshold}% failures  ·  ` +
                    `${opts.includeOffline ? 'including offline' : 'active only'}`,
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
        if (devices.length > 0) {
            console.log(label('\nTargets:'));
            for (const d of devices) console.log(`  ${muted('·')} ${d.device}`);
        }
        return;
    }

    if (devices.length === 0) {
        const filterHint = opts.filter && Object.keys(opts.filter).length
            ? ` (filters: ${Object.entries(opts.filter).map(([k, v]) => `${k}=${v}`).join(', ')})`
            : '';
        if (isJsonMode()) {
            printOk({
                product: productId,
                name,
                fleet: true,
                device_count: 0,
                devices: [],
                summary: { attempted: 0, succeeded: 0, failed: 0, failureRate: 0 },
                aborted: false,
                reason: null,
            });
            return;
        }
        console.log(warning(`No matching devices on product "${productId}"${filterHint}.`));
        return;
    }

    const confirmed = await maybeConfirmFleet({
        productId,
        name,
        steps: pb.steps.length,
        deviceCount: devices.length,
        batchSize,
        failureThreshold,
        skipPrompt: !!opts.yes || !!opts.check,
    });
    if (!confirmed) {
        if (isJsonMode()) {
            printOk({ product: productId, name, fleet: true, cancelled: true });
        } else {
            console.log(warning('Cancelled.'));
        }
        return;
    }

    const mode = opts.check ? 'check' : 'apply';
    const startedAt = new Date().toISOString();
    const spinner = isJsonMode()
        ? null
        : createSpinner(
              `Rolling out "${name}" to ${devices.length} device(s) in batches of ${batchSize}...`,
          ).start();

    const renderBatchLabel = (info) => {
        if (!spinner) return;
        spinner.text =
            `Batch ${info.index + 1} — ${info.deviceIds.length} device(s) ` +
            `(${info.firstIndex + 1}-${info.firstIndex + info.deviceIds.length}/${devices.length})`;
    };

    const batchLines = [];

    let outcome;
    try {
        outcome = await runFleetPlaybook(pb, devices, {
            user,
            batchSize,
            failureThreshold,
            overrides,
            checkMode: !!opts.check,
            onBatchStart: renderBatchLabel,
            onBatchEnd: ({ index, deviceIds, results, cumulative }) => {
                const ok = results.filter((r) => r?.ok).length;
                const fail = results.length - ok;
                const line =
                    `  ${muted('·')} Batch ${index + 1}: ` +
                    `${success(ok + ' ok')}, ${fail > 0 ? errorStyle(fail + ' failed') : muted('0 failed')}` +
                    `  ${muted(`[${cumulative.succeeded}/${cumulative.attempted} done · ${cumulative.failureRate.toFixed(1)}% failure]`)}`;
                batchLines.push(line);
                if (spinner) {
                    spinner.text =
                        `Batch ${index + 1} done — ${cumulative.succeeded}/${cumulative.attempted} ok ` +
                        `(${cumulative.failureRate.toFixed(1)}% failure)`;
                }
            },
        });
        spinner?.stop();
    } catch (err) {
        spinner?.fail('Rollout failed');
        throw err;
    }
    const finishedAt = new Date().toISOString();

    const summary = {
        attempted: outcome.attempted,
        succeeded: outcome.succeeded,
        failed: outcome.failed,
        failureRate: outcome.failureRate,
        total: devices.length,
    };

    const report = buildRunReport({
        productId,
        name,
        playbook: pb,
        user: user || requireConfig().username,
        startedAt,
        finishedAt,
        mode,
        batchSize,
        failureThreshold,
        filters: opts.filter,
        group: opts.group,
        includeOffline: !!opts.includeOffline,
        resolvedVars: resolvedScope,
        summary,
        reason: outcome.reason,
        results: outcome.results,
        batches: outcome.batches,
    });

    const upload = await uploadFleetRunReport({ product: productId, report, user });

    if (isJsonMode()) {
        printOk({
            product: productId,
            name,
            fleet: true,
            mode,
            startedAt,
            finishedAt,
            batch_size: batchSize,
            failure_threshold: failureThreshold,
            device_count: devices.length,
            batches: outcome.batches,
            summary,
            aborted: outcome.aborted,
            reason: outcome.reason,
            results: outcome.results,
            report_uploaded: upload.ok,
            report_path: upload.ok ? upload.path : null,
            report_error: upload.ok ? null : upload.reason,
        });
        return;
    }

    console.log(
        `\n${label(pb.name || name)} ${muted(`(${mode} · fleet · ${devices.length} device(s))`)}`,
    );
    for (const line of batchLines) console.log(line);

    if (outcome.aborted) {
        console.log(
            errorStyle(
                `\nRollout aborted: ${
                    outcome.reason === 'failure-threshold'
                        ? `failure threshold ${failureThreshold}% reached`
                        : outcome.reason
                }`,
            ),
        );
    } else {
        console.log(success(`\nRollout complete.`));
    }

    console.log(
        muted(
            `  ${summary.succeeded}/${summary.attempted} ok, ${summary.failed} failed ` +
                `(${summary.failureRate.toFixed(1)}% failure rate)` +
                (devices.length > summary.attempted
                    ? `, ${devices.length - summary.attempted} skipped`
                    : ''),
        ),
    );

    if (summary.failed > 0 || outcome.results.some((r) => r?.skipped)) {
        console.log('');
        console.log(renderFleetResultTable(outcome.results));
    }

    if (upload.ok) {
        console.log(muted(`\nReport: ${productId}:${upload.path}`));
    } else {
        const note =
            upload.reason === 'storage-missing'
                ? 'product file storage not enabled — run report not persisted.'
                : `run report upload failed: ${upload.reason}`;
        console.log(warning(`\n${note}`));
    }
}

function registerRun(playbook) {
    playbook
        .command('run <productId> <name>')
        .helpGroup('Playbooks:')
        .description('Run a product playbook against one device or the whole fleet (progressive rollout)')
        .option('-d, --device <id>', 'Target device ID (single-device mode)')
        .option(
            '--fleet',
            'Fleet rollout: run progressively across every matching device of the product',
        )
        .option(
            '--batch-size <n>',
            'Devices attempted in parallel per batch (fleet mode; default: 5)',
            parsePositiveInt('batch-size'),
        )
        .option(
            '--failure-threshold <p>',
            `Abort rollout when cumulative failure rate ≥ P percent (fleet mode; default: ${DEFAULT_FAILURE_THRESHOLD})`,
            (v) => {
                const n = Number(v);
                if (!Number.isFinite(n) || n < 0 || n > 100) {
                    throw inputError('--failure-threshold must be a number between 0 and 100');
                }
                return n;
            },
        )
        .option('-g, --group <id>', 'Restrict to devices in this asset group (fleet mode)')
        .option(
            '--filter <key=value>',
            'Extra server-side filter for device selection (repeatable, fleet mode)',
            collectKeyValue,
            {},
        )
        .option(
            '--include-offline',
            'Include offline devices in the rollout (fleet mode; default: active only)',
        )
        .option(
            '-v, --var <key=value>',
            'Override a playbook variable (repeatable, values coerced to the declared type)',
            collectKeyValue,
            {},
        )
        .option('--vars-file <path>', 'Load variable overrides from a YAML/JSON file')
        .option('--dry-run', 'Print the resolved plan without contacting any device')
        .option('--check', 'Contact devices read-only and report what each step would change')
        .option('-y, --yes', 'Skip the interactive confirmation prompt')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, name, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            const fleetMode = !!opts.fleet;
            if (!fleetMode && !opts.device) {
                printErr('Pass either --device <id> or --fleet.', { code: 'input_error' });
                return;
            }
            if (fleetMode && opts.device) {
                printErr('--device and --fleet are mutually exclusive.', { code: 'input_error' });
                return;
            }
            if (!fleetMode) {
                const fleetOnly = [];
                if (opts.batchSize !== undefined) fleetOnly.push('--batch-size');
                if (opts.failureThreshold !== undefined) fleetOnly.push('--failure-threshold');
                if (opts.group) fleetOnly.push('--group');
                if (opts.filter && Object.keys(opts.filter).length) fleetOnly.push('--filter');
                if (opts.includeOffline) fleetOnly.push('--include-offline');
                if (fleetOnly.length > 0) {
                    printErr(
                        `${fleetOnly.join(', ')} ${fleetOnly.length === 1 ? 'is' : 'are'} only valid with --fleet.`,
                        { code: 'input_error' },
                    );
                    return;
                }
            }

            let pb;
            try {
                pb = await loadProductPlaybook({ productId, name, user });
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code: err.code || code });
                return;
            }

            let overrides;
            try {
                overrides = collectCliOverrides(pb, opts.var, opts.varsFile);
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code: code === 'error' ? 'input_error' : code });
                return;
            }

            let resolvedScope;
            try {
                resolvedScope = resolveVarScope(pb, overrides);
            } catch (err) {
                printErr(err.message, { code: 'input_error' });
                return;
            }

            try {
                if (fleetMode) {
                    await runFleet({ productId, name, pb, overrides, resolvedScope, user, opts });
                } else {
                    await runSingleDevice({
                        productId,
                        name,
                        pb,
                        overrides,
                        resolvedScope,
                        user,
                        opts,
                    });
                }
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code: err.code || code });
            }
        });
}

export function registerProductPlaybookCommand(product) {
    const playbook = product
        .command('playbook')
        .helpGroup('Playbooks:')
        .description(
            `Manage playbooks stored on a product. ${hint('Subcommands: list, upload, download, delete, run.')}`,
        );

    registerList(playbook);
    registerUpload(playbook);
    registerDownload(playbook);
    registerDelete(playbook);
    registerRun(playbook);
}
