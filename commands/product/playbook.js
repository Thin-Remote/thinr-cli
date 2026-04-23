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
    uploadProductPlaybook,
} from '../../lib/product.js';
import { parsePlaybook } from '../../lib/playbook/loader.js';
import { buildDryRunPlan, runPlaybook } from '../../lib/playbook/runner.js';
import { coerceCliVarValue, listVariables, resolveVarScope } from '../../lib/playbook/vars.js';
import { getDevices } from '../../lib/devices.js';
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
import { applyJsonFlag, collectKeyValue, ensureConfigured, getGlobalUser } from '../_shared.js';

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

function registerRun(playbook) {
    playbook
        .command('run <productId> <name>')
        .helpGroup('Playbooks:')
        .description('Run a product playbook against a single device (safe pre-flight before rollout)')
        .requiredOption('-d, --device <id>', 'Target device ID (single-device only)')
        .option(
            '-v, --var <key=value>',
            'Override a playbook variable (repeatable, values coerced to the declared type)',
            collectKeyValue,
            {},
        )
        .option('--vars-file <path>', 'Load variable overrides from a YAML/JSON file')
        .option('--dry-run', 'Print the resolved plan without contacting the device')
        .option('--check', 'Contact the device read-only and report what each step would change')
        .option('-y, --yes', 'Skip the interactive confirmation prompt')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, name, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            let content;
            try {
                const entry = await findProductPlaybook(productId, name, user);
                if (!entry) {
                    printErr(
                        `Playbook "${name}" is not registered on product "${productId}". Available: ${(await listProductPlaybooks(productId, user)).map((e) => e.name).join(', ') || '(none)'}`,
                        { code: 'not_found' },
                    );
                    return;
                }
                content = await readProductPlaybook(productId, name, user);
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code });
                return;
            }

            let pb;
            try {
                pb = parsePlaybook(content, { sourcePath: `${name}.yaml` });
            } catch (err) {
                const { message } = classifyError(err);
                printErr(message, { code: 'input_error' });
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

            pb.target.devices = [opts.device];
            pb.target.product = productId;
            pb.target.group = null;

            // ── Dry-run path ─────────────────────────────────────────
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

            // ── Confirmation ─────────────────────────────────────────
            let confirmed;
            try {
                confirmed = await maybeConfirm({
                    productId,
                    name,
                    deviceId: opts.device,
                    steps: pb.steps.length,
                    skipPrompt: !!opts.yes || !!opts.check,
                });
            } catch (err) {
                printErr(err.message, { code: 'input_error' });
                return;
            }
            if (!confirmed) {
                if (isJsonMode()) {
                    printOk({ product: productId, name, device: opts.device, cancelled: true });
                } else {
                    console.log(warning('Cancelled.'));
                }
                return;
            }

            // ── Resolve the single device ────────────────────────────
            let device;
            try {
                const all = await getDevices({ product: productId }, user);
                device =
                    all.find((d) => d.device === opts.device) || {
                        device: opts.device,
                        connection: { active: false },
                    };
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code });
                return;
            }

            // ── Execute ──────────────────────────────────────────────
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
                const { message, code } = classifyError(err);
                printErr(message, { code });
                return;
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
