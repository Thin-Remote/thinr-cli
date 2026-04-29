// @ts-check
import Table from 'cli-table3';
import {
    addLogSource,
    getProductLogs,
    listPresets,
    removeLogSource,
    setDefaultLogSource,
} from '../../lib/product/logs.js';
import { hint, info, label, muted, success } from '../../lib/format.js';
import { classifyError, isJsonMode, printErr, printOk } from '../../lib/output.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from '../_shared.js';

function truncate(value, max = 60) {
    if (typeof value !== 'string') return '';
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function registerList(logs) {
    logs
        .command('list <productId>')
        .helpGroup('Log sources:')
        .description('List the log sources configured on a product')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            try {
                const cfg = await getProductLogs(productId, user);
                const fallback = !!(/** @type {any} */ (cfg).__fallback);
                const def = cfg.default || cfg.sources[0]?.name || null;

                if (isJsonMode()) {
                    printOk({
                        product: productId,
                        fallback,
                        default: def,
                        sources: cfg.sources,
                    });
                    return;
                }

                if (fallback) {
                    console.log(
                        `${muted('No logs property set on')} ${info(productId)}${muted('. Showing the synthetic fallback:')}`,
                    );
                } else {
                    console.log(`${cfg.sources.length} source(s) on ${info(productId)}:`);
                }
                const table = new Table({
                    head: ['Name', 'Command', 'Pattern', 'Default'].map((h) => label(h)),
                    style: { head: [], border: ['gray'] },
                });
                for (const s of cfg.sources) {
                    const pat = s.preset
                        ? muted(`preset:${s.preset}`)
                        : s.pattern
                          ? truncate(s.pattern, 30)
                          : muted('—');
                    table.push([
                        s.name,
                        truncate(s.command),
                        pat,
                        s.name === def ? success('✓') : muted('—'),
                    ]);
                }
                console.log(table.toString());
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });
}

function registerAdd(logs) {
    logs
        .command('add <productId> <name>')
        .helpGroup('Log sources:')
        .description('Add or replace a log source on a product')
        .requiredOption('-c, --command <cmd>', 'Shell command the agent should exec-stream for this source')
        .option('--default', 'Mark this source as the active default')
        .option(
            '--pattern <regex>',
            'Custom regex with named groups (time, level, msg) for structured rendering',
        )
        .option(
            '--preset <name>',
            'Named preset for structured rendering (see `thinr product logs presets`)',
        )
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, name, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            try {
                const { config, action } = await addLogSource(
                    productId,
                    {
                        name,
                        command: opts.command,
                        makeDefault: !!opts.default,
                        pattern: opts.pattern,
                        preset: opts.preset,
                    },
                    user,
                );
                if (isJsonMode()) {
                    printOk({ product: productId, action, name, config });
                    return;
                }
                console.log(
                    `${success(action === 'added' ? 'Added' : 'Updated')} source ${info(name)} on product ${info(productId)}` +
                        (opts.default ? ` ${muted('(default)')}` : ''),
                );
                console.log(`  ${muted('command:')} ${truncate(opts.command, 80)}`);
                if (opts.preset) console.log(`  ${muted('preset:')} ${opts.preset}`);
                if (opts.pattern) console.log(`  ${muted('pattern:')} ${truncate(opts.pattern, 80)}`);
                console.log(
                    `  ${muted('total sources:')} ${config.sources.length}${
                        config.default ? `  ${muted('default:')} ${config.default}` : ''
                    }`,
                );
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code: code === 'error' ? 'input_error' : code });
            }
        });
}

function registerRemove(logs) {
    logs
        .command('remove <productId> <name>')
        .alias('rm')
        .helpGroup('Log sources:')
        .description('Remove a log source from a product (idempotent)')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, name, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            try {
                const { removed, config } = await removeLogSource(productId, name, user);
                if (isJsonMode()) {
                    printOk({
                        product: productId,
                        name,
                        removed,
                        config: config || null,
                        cleared: removed && config === null,
                    });
                    return;
                }
                if (!removed) {
                    console.log(
                        `Source ${info(name)} was not configured on ${info(productId)}.`,
                    );
                    return;
                }
                if (config === null) {
                    console.log(
                        `${success('Removed')} source ${info(name)} (last one). ${muted('Logs property cleared — falling back to system journal.')}`,
                    );
                    return;
                }
                console.log(
                    `${success('Removed')} source ${info(name)}. ${muted(`${config.sources.length} source(s) remain`)}` +
                        (config.default ? ` ${muted(`· default: ${config.default}`)}` : ''),
                );
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code: code === 'error' ? 'input_error' : code });
            }
        });
}

function registerSetDefault(logs) {
    logs
        .command('set-default <productId> <name>')
        .helpGroup('Log sources:')
        .description('Set the active default source on a product')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, name, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            try {
                const config = await setDefaultLogSource(productId, name, user);
                if (isJsonMode()) {
                    printOk({ product: productId, default: config.default, config });
                    return;
                }
                console.log(
                    `${success('Default set')}: ${info(name)} on product ${info(productId)}.`,
                );
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code: code === 'error' ? 'input_error' : code });
            }
        });
}

function registerShow(logs) {
    logs
        .command('show <productId> <name>')
        .helpGroup('Log sources:')
        .description('Show a single log source (full command, untruncated)')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, name, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            try {
                const cfg = await getProductLogs(productId, user);
                const source = cfg.sources.find((s) => s.name === name);
                if (!source) {
                    const available = cfg.sources.map((s) => s.name).join(', ') || '(none)';
                    printErr(
                        `Source "${name}" is not configured on product "${productId}". Available: ${available}`,
                        { code: 'not_found' },
                    );
                    return;
                }
                const fallback = !!(/** @type {any} */ (cfg).__fallback);
                const isDefault = (cfg.default || cfg.sources[0]?.name) === name;
                if (isJsonMode()) {
                    printOk({
                        product: productId,
                        fallback,
                        name: source.name,
                        command: source.command,
                        pattern: source.pattern || null,
                        preset: source.preset || null,
                        default: isDefault,
                    });
                    return;
                }
                console.log(`${label('Source')}: ${info(source.name)}${isDefault ? ` ${muted('(default)')}` : ''}`);
                console.log(`${label('Command')}: ${source.command}`);
                if (source.preset) console.log(`${label('Preset')}: ${source.preset}`);
                if (source.pattern) console.log(`${label('Pattern')}: ${source.pattern}`);
                if (fallback) console.log(hint('(synthetic fallback — no logs property set)'));
            } catch (err) {
                const { message, code } = classifyError(err);
                printErr(message, { code });
            }
        });
}

function registerPresets(logs) {
    logs
        .command('presets')
        .helpGroup('Log sources:')
        .description('List the named log line patterns shipped with the CLI')
        .option('-j, --json', 'Output as JSON')
        .action(async (opts) => {
            applyJsonFlag(opts);
            const presets = listPresets();
            if (isJsonMode()) {
                printOk({ presets });
                return;
            }
            const table = new Table({
                head: ['Name', 'Description', 'Pattern'].map((h) => label(h)),
                style: { head: [], border: ['gray'] },
            });
            for (const p of presets) {
                table.push([p.name, p.description, truncate(p.pattern, 60)]);
            }
            console.log(`${presets.length} preset(s) available:`);
            console.log(table.toString());
        });
}

export function registerProductLogsCommand(product) {
    const logs = product
        .command('logs')
        .helpGroup('Log sources:')
        .description(
            `Manage log sources stored on a product. ${hint('Subcommands: list, add, remove, set-default, show, presets.')}`,
        );

    registerList(logs);
    registerAdd(logs);
    registerRemove(logs);
    registerSetDefault(logs);
    registerShow(logs);
    registerPresets(logs);
}
