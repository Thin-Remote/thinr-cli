// @ts-check
import { Buffer } from 'node:buffer';
import {
    getProducts,
    deleteProductWithStorage,
    installProductScript,
    removeProductScript,
    listProductScripts,
    readProductScript,
    getProductApi,
    getProductProperties,
    getProductProperty,
    setProductProperty,
    deleteProductProperty,
    listDashboardMetrics,
    upsertDashboardMetric,
    removeDashboardMetric,
    DASHBOARD_METRICS_PROPERTY,
    findProductPlaybook,
    listProductPlaybooks,
    readProductPlaybook,
    uploadProductPlaybook,
    deleteProductPlaybook,
    uploadFleetRunReport,
} from '../product.js';
import { createDeviceAPI } from '../device-api.js';
import { TIMEOUTS } from '../constants.js';
import { runProductFanOut } from '../product-orchestrator.js';
import { requireConfig } from '../config.js';
import { filterActiveDevices, getDevices } from '../devices.js';
import { parsePlaybook } from '../playbook/loader.js';
import { buildDryRunPlan, runPlaybook } from '../playbook/runner.js';
import { DEFAULT_FAILURE_THRESHOLD, runFleetPlaybook } from '../playbook/fleet.js';
import { listVariables, resolveVarScope } from '../playbook/vars.js';
import { inputError } from '../errors.js';

async function toolProducts(args) {
    const user = args.user;
    const products = await getProducts(user);
    if (products.length === 0) {
        return { content: [{ type: 'text', text: 'No products configured' }], isError: false };
    }
    const lines = await Promise.all(
        products.map(async (p) => {
            const id = p.product;
            const label = p.name && p.name !== id ? ` (${p.name})` : '';
            const enabled = p.enabled ? '✓' : '✗';
            const apis = await getProductApi(id, user);
            const scripts = Object.keys(apis).length;
            const scriptsLabel = scripts > 0 ? ` — ${scripts} api-resource(s)` : '';
            return `${enabled}  ${id}${label}${scriptsLabel}`;
        }),
    );
    return {
        content: [{ type: 'text', text: `${products.length} product(s):\n${lines.join('\n')}` }],
        isError: false,
    };
}

async function toolProductDelete(args) {
    if (!args.product) throw inputError('product is required');
    const { steps } = await deleteProductWithStorage(args.product, args.user, {
        keepStorage: !!args.keep_storage,
    });
    return {
        content: [
            { type: 'text', text: `Removed "${args.product}":\n  - ${steps.join('\n  - ')}` },
        ],
        isError: false,
    };
}

async function toolProductScriptList(args) {
    if (!args.product) throw inputError('product is required');
    const entries = await listProductScripts(args.product, args.user);
    const header =
        entries.length === 0
            ? `No scripts in product "${args.product}"`
            : `${entries.length} script(s) in product "${args.product}":`;
    const lines = entries.map((e) => {
        const marker = e.registered ? '[api]' : '[orphan]';
        return `  ${marker} ${e.name}  (${e.size} bytes) → resource: ${e.stem}`;
    });
    return {
        content: [{ type: 'text', text: [header, ...lines].join('\n') }],
        isError: false,
    };
}

async function toolProductScriptRead(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.name) throw inputError('name is required');
    const body = await readProductScript(args.product, args.name, args.user);
    return {
        content: [{ type: 'text', text: body }],
        isError: false,
    };
}

async function toolProductScriptWrite(args) {
    const { steps, stem } = await installProductScript({
        product: args.product,
        name: args.name,
        content: args.content,
        user: args.user,
        icon: args.icon,
        input: args.input,
        output: args.output,
    });
    const lines = [
        `Installed product script "${args.name}" on "${args.product}".`,
        `Steps:`,
        ...steps.map((s) => `  - ${s}`),
        `Invoke on any device of this product with thinr_resource_call(device=<id>, resource="${stem}", inputs={input: {...}}).`,
    ];
    return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: false,
    };
}

async function toolProductPropertyGet(args) {
    if (!args.product) throw inputError('product is required');
    if (args.property) {
        const value = await getProductProperty(args.product, args.property, args.user);
        return {
            content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            isError: false,
        };
    }
    const list = await getProductProperties(args.product, args.user);
    const names = Array.isArray(list) ? list.map((p) => p.property).filter(Boolean) : [];
    return {
        content: [{ type: 'text', text: names.length ? names.join('\n') : '(no properties)' }],
        isError: false,
    };
}

async function toolProductPropertySet(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.property) throw inputError('property is required');
    if (args.value === undefined) throw inputError('value is required');
    const saved = await setProductProperty(args.product, args.property, args.value, args.user);
    return {
        content: [
            {
                type: 'text',
                text: `Saved property "${saved.property}" on product "${saved.product || args.product}" (value: ${JSON.stringify(saved.value)})`,
            },
        ],
        isError: false,
    };
}

async function toolProductPropertyDelete(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.property) throw inputError('property is required');
    const removed = await deleteProductProperty(args.product, args.property, args.user);
    return {
        content: [
            {
                type: 'text',
                text: removed
                    ? `Deleted property "${args.property}" from product "${args.product}".`
                    : `Property "${args.property}" was not set on product "${args.product}".`,
            },
        ],
        isError: false,
    };
}

async function toolProductMetricList(args) {
    if (!args.product) throw inputError('product is required');
    const metrics = await listDashboardMetrics(args.product, args.user);
    if (metrics.length === 0) {
        return {
            content: [
                {
                    type: 'text',
                    text: `No dashboard metrics configured on product "${args.product}" (property "${DASHBOARD_METRICS_PROPERTY}" is empty).`,
                },
            ],
            isError: false,
        };
    }
    const lines = metrics.map((m) => {
        const parts = [
            m.name,
            `resource=${m.resource}`,
            m.field ? `field=${m.field}` : null,
            m.aggregation ? `agg=${m.aggregation}` : null,
            m.visualization ? `viz=${m.visualization}` : null,
            m.interval ? `interval=${m.interval}s` : null,
        ].filter(Boolean);
        return `  - ${parts.join('  ')}${m.label ? `  · ${m.label}` : ''}`;
    });
    return {
        content: [
            {
                type: 'text',
                text: `${metrics.length} metric(s) on "${args.product}":\n${lines.join('\n')}`,
            },
        ],
        isError: false,
    };
}

async function toolProductMetricSet(args) {
    if (!args.product) throw inputError('product is required');
    const metric = {
        name: args.name,
        label: args.label,
        resource: args.resource,
        field: args.field,
        aggregation: args.aggregation,
        visualization: args.visualization,
        interval: args.interval,
        unit: args.unit,
    };
    for (const k of Object.keys(metric)) if (metric[k] === undefined) delete metric[k];
    const { action, count } = await upsertDashboardMetric(args.product, metric, args.user);
    return {
        content: [
            {
                type: 'text',
                text: `Metric "${metric.name}" ${action} on product "${args.product}" (total: ${count}).`,
            },
        ],
        isError: false,
    };
}

async function toolProductMetricDelete(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.name) throw inputError('name is required');
    const { action, count } = await removeDashboardMetric(args.product, args.name, args.user);
    return {
        content: [
            {
                type: 'text',
                text:
                    action === 'removed'
                        ? `Removed metric "${args.name}" from product "${args.product}" (remaining: ${count}).`
                        : `Metric "${args.name}" was not configured on product "${args.product}".`,
            },
        ],
        isError: false,
    };
}

async function toolProductScriptDelete(args) {
    const { steps } = await removeProductScript({
        product: args.product,
        name: args.name,
        user: args.user,
    });
    return {
        content: [
            {
                type: 'text',
                text: `Removed product script "${args.name}" from "${args.product}":\n  - ${steps.join('\n  - ')}`,
            },
        ],
        isError: false,
    };
}

async function toolProductPlaybookList(args) {
    if (!args.product) throw inputError('product is required');
    const entries = await listProductPlaybooks(args.product, args.user);
    if (entries.length === 0) {
        return {
            content: [
                {
                    type: 'text',
                    text: `No playbooks registered on product "${args.product}".`,
                },
            ],
            isError: false,
        };
    }
    const lines = entries.map((e) => {
        const desc = e.description ? ` — ${e.description}` : '';
        return `  - ${e.name}${desc}  (${e.path})`;
    });
    return {
        content: [
            {
                type: 'text',
                text: `${entries.length} playbook(s) on "${args.product}":\n${lines.join('\n')}`,
            },
        ],
        isError: false,
    };
}

async function toolProductPlaybookRead(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.name) throw inputError('name is required');
    const content = await readProductPlaybook(args.product, args.name, args.user);
    return {
        content: [{ type: 'text', text: content }],
        isError: false,
    };
}

async function toolProductPlaybookWrite(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.name) throw inputError('name is required');
    if (typeof args.content !== 'string') throw inputError('content (YAML string) is required');
    const result = await uploadProductPlaybook({
        product: args.product,
        name: args.name,
        content: args.content,
        description: args.description,
        user: args.user,
        skipValidation: !!args.skip_validation,
    });
    const header = `Playbook "${result.entry.name}" ${result.action} on product "${args.product}"${
        result.replaced ? ' (replaced existing entry)' : ''
    }.`;
    const steps = result.steps.map((s) => `  - ${s}`);
    return {
        content: [{ type: 'text', text: [header, ...steps].join('\n') }],
        isError: false,
    };
}

async function toolProductPlaybookRun(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.name) throw inputError('name is required');
    if (!args.device) throw inputError('device is required (single-device only)');

    const entry = await findProductPlaybook(args.product, args.name, args.user);
    if (!entry) {
        const available = await listProductPlaybooks(args.product, args.user);
        throw inputError(
            `Playbook "${args.name}" is not registered on product "${args.product}". Available: ${available.map((e) => e.name).join(', ') || '(none)'}`,
        );
    }

    const content = await readProductPlaybook(args.product, args.name, args.user);
    const pb = parsePlaybook(content, { sourcePath: `${args.name}.yaml` });

    const rawVars =
        args.vars && typeof args.vars === 'object' && !Array.isArray(args.vars) ? args.vars : {};

    let resolvedScope;
    try {
        resolvedScope = resolveVarScope(pb, rawVars);
    } catch (err) {
        throw inputError(err.message);
    }

    pb.target.devices = [args.device];
    pb.target.product = args.product;
    pb.target.group = null;

    if (args.dry_run) {
        const plan = buildDryRunPlan(pb, { overrides: rawVars });
        const payload = {
            dry_run: true,
            product: args.product,
            name: args.name,
            device: args.device,
            variables: listVariables(pb),
            vars: resolvedScope,
            steps: plan,
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
            isError: false,
        };
    }

    const all = await getDevices({ product: args.product }, args.user);
    const device =
        all.find((d) => d.device === args.device) || {
            device: args.device,
            connection: { active: false },
        };

    const results = await runPlaybook(pb, [device], {
        user: args.user,
        concurrency: 1,
        failFast: true,
        checkMode: !!args.check,
        overrides: rawVars,
    });
    const result = results[0];
    const payload = {
        product: args.product,
        name: args.name,
        device: args.device,
        mode: args.check ? 'check' : 'apply',
        ok: !!result?.ok,
        result,
    };
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: !result?.ok,
    };
}

async function toolProductPlaybookRollout(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.name) throw inputError('name is required');

    const batchSize =
        Number.isFinite(args.batch_size) && args.batch_size > 0
            ? Math.floor(args.batch_size)
            : 5;
    const failureThreshold =
        args.failure_threshold === undefined || args.failure_threshold === null
            ? DEFAULT_FAILURE_THRESHOLD
            : Number(args.failure_threshold);
    if (!Number.isFinite(failureThreshold) || failureThreshold < 0 || failureThreshold > 100) {
        throw inputError('failure_threshold must be a number between 0 and 100');
    }

    const entry = await findProductPlaybook(args.product, args.name, args.user);
    if (!entry) {
        const available = await listProductPlaybooks(args.product, args.user);
        throw inputError(
            `Playbook "${args.name}" is not registered on product "${args.product}". Available: ${available.map((e) => e.name).join(', ') || '(none)'}`,
        );
    }

    const content = await readProductPlaybook(args.product, args.name, args.user);
    const pb = parsePlaybook(content, { sourcePath: `${args.name}.yaml` });

    const rawVars =
        args.vars && typeof args.vars === 'object' && !Array.isArray(args.vars) ? args.vars : {};

    let resolvedScope;
    try {
        resolvedScope = resolveVarScope(pb, rawVars);
    } catch (err) {
        throw inputError(err.message);
    }

    const filters = {};
    if (args.filter && typeof args.filter === 'object' && !Array.isArray(args.filter)) {
        for (const [k, v] of Object.entries(args.filter)) {
            if (!/^[A-Za-z0-9_]+$/.test(k)) {
                throw inputError(`Invalid filter key "${k}"`);
            }
            filters[k] = v;
        }
    }

    const baseFilter = { product: args.product };
    if (args.group) baseFilter.asset_group = args.group;
    Object.assign(baseFilter, filters);
    let devices = await getDevices(baseFilter, args.user);
    if (!args.include_offline) devices = filterActiveDevices(devices);

    pb.target.devices = null;
    pb.target.product = args.product;
    pb.target.group = args.group || null;

    if (args.dry_run) {
        const plan = buildDryRunPlan(pb, { overrides: rawVars });
        const payload = {
            dry_run: true,
            product: args.product,
            name: args.name,
            fleet: true,
            device_count: devices.length,
            devices: devices.map((d) => d.device),
            batch_size: batchSize,
            failure_threshold: failureThreshold,
            variables: listVariables(pb),
            vars: resolvedScope,
            steps: plan,
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
            isError: false,
        };
    }

    if (devices.length === 0) {
        const payload = {
            product: args.product,
            name: args.name,
            fleet: true,
            device_count: 0,
            aborted: false,
            summary: { attempted: 0, succeeded: 0, failed: 0, failureRate: 0 },
            message: 'no matching devices',
        };
        return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
            isError: false,
        };
    }

    const startedAt = new Date().toISOString();
    const outcome = await runFleetPlaybook(pb, devices, {
        user: args.user,
        batchSize,
        failureThreshold,
        overrides: rawVars,
        checkMode: !!args.check,
    });
    const finishedAt = new Date().toISOString();

    const summary = {
        attempted: outcome.attempted,
        succeeded: outcome.succeeded,
        failed: outcome.failed,
        failureRate: outcome.failureRate,
        total: devices.length,
    };

    const report = {
        product: args.product,
        name: args.name,
        user: args.user || requireConfig().username,
        startedAt,
        finishedAt,
        durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        mode: args.check ? 'check' : 'apply',
        playbook: {
            name: pb.name || null,
            description: pb.description || null,
            steps: pb.steps.length,
        },
        rollout: {
            batchSize,
            failureThreshold,
            filters: Object.keys(filters).length > 0 ? filters : null,
            group: args.group || null,
            includeOffline: !!args.include_offline,
        },
        vars: resolvedScope,
        summary,
        aborted: outcome.aborted,
        reason: outcome.reason,
        batches: outcome.batches,
        devices: outcome.results.map((r) => ({
            device: r?.device,
            ok: !!r?.ok,
            skipped: !!r?.skipped,
            error: r?.error || null,
        })),
    };

    const upload = await uploadFleetRunReport({ product: args.product, report, user: args.user });

    const payload = {
        product: args.product,
        name: args.name,
        fleet: true,
        mode: args.check ? 'check' : 'apply',
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
    };
    return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: outcome.aborted || summary.failed > 0,
    };
}

async function toolProductPlaybookDelete(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.name) throw inputError('name is required');
    const result = await deleteProductPlaybook({
        product: args.product,
        name: args.name,
        user: args.user,
    });
    const header = result.removed
        ? `Deleted playbook "${args.name}" from product "${args.product}".`
        : `Playbook "${args.name}" was not registered on product "${args.product}".`;
    const steps = result.steps.map((s) => `  - ${s}`);
    return {
        content: [{ type: 'text', text: [header, ...steps].join('\n') }],
        isError: false,
    };
}

/**
 * @typedef {{
 *   device: string,
 *   ok: boolean,
 *   exitCode: number | null,
 *   timedOut: boolean,
 *   durationMs: number,
 *   stdout: string,
 *   stderr: string,
 *   error?: string,
 * }} ExecEntry
 */

async function toolProductWrite(args) {
    if (!args.product) throw inputError('product is required');
    if (typeof args.path !== 'string' || !args.path) throw inputError('path is required');
    if (typeof args.content !== 'string') throw inputError('content (string) is required');
    const payload = Buffer.from(args.content, 'utf8');

    const { devices, entries } = await runProductFanOut({
        product: args.product,
        group: args.group,
        includeOffline: !!args.all,
        user: args.user,
        concurrency:
            Number.isFinite(args.concurrency) && args.concurrency > 0
                ? Math.floor(args.concurrency)
                : 10,
        failFast: !!args.fail_fast,
        worker: async (device) => {
            const t0 = Date.now();
            try {
                const api = createDeviceAPI(device.device, { user: args.user || undefined });
                await api.writeFile(args.path, payload);
                return {
                    device: device.device,
                    ok: true,
                    bytes: payload.byteLength,
                    durationMs: Date.now() - t0,
                };
            } catch (err) {
                return {
                    device: device.device,
                    ok: false,
                    bytes: 0,
                    durationMs: Date.now() - t0,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        },
        skipped: (device, firstFailure) => ({
            device: device.device,
            ok: false,
            bytes: 0,
            durationMs: 0,
            error: `skipped (fail-fast after ${firstFailure})`,
        }),
        isFailure: (entry) => !entry.ok,
    });

    if (devices.length === 0) {
        const suffix = args.group ? `, group="${args.group}"` : '';
        return {
            content: [
                {
                    type: 'text',
                    text: `No devices to upload to (product="${args.product}"${suffix}).`,
                },
            ],
            isError: false,
        };
    }

    const okCount = entries.filter((e) => e.ok).length;
    const lines = [];
    lines.push(
        `Uploaded to ${okCount}/${entries.length} device(s) of product "${args.product}" (path: ${args.path}, ${payload.byteLength} bytes each).\n`,
    );
    for (const e of entries) {
        lines.push(
            `${e.device}  ${e.ok ? 'OK' : 'FAIL'}  ${e.durationMs}ms${e.ok ? '' : `  · ${e.error}`}`,
        );
    }
    return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: okCount < entries.length,
    };
}

async function toolProductExec(args) {
    if (!args.product) throw inputError('product is required');
    if (!args.command) throw inputError('command is required');
    const concurrency =
        Number.isFinite(args.concurrency) && args.concurrency > 0
            ? Math.floor(args.concurrency)
            : 10;
    const timeout =
        Number.isFinite(args.timeout) && args.timeout > 0
            ? Math.floor(args.timeout)
            : TIMEOUTS.DEFAULT_EXEC_SECONDS;

    const { devices, entries, durationMs } = await runProductFanOut({
        product: args.product,
        group: args.group,
        includeOffline: !!args.all,
        user: args.user,
        concurrency,
        failFast: !!args.fail_fast,
        worker: async (device) => {
            const perStart = Date.now();
            let stdout = '';
            let stderr = '';
            try {
                const api = createDeviceAPI(device.device, { user: args.user || undefined });
                const { exitCode, timedOut } = await api.execStream(args.command, {
                    timeout,
                    onStdout: (s) => {
                        stdout += s;
                    },
                    onStderr: (s) => {
                        stderr += s;
                    },
                });
                return {
                    device: device.device,
                    ok: !timedOut && exitCode === 0,
                    exitCode: exitCode ?? null,
                    timedOut: !!timedOut,
                    durationMs: Date.now() - perStart,
                    stdout,
                    stderr,
                };
            } catch (err) {
                return {
                    device: device.device,
                    ok: false,
                    exitCode: null,
                    timedOut: false,
                    durationMs: Date.now() - perStart,
                    stdout,
                    stderr,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        },
        skipped: (device, firstFailure) => ({
            device: device.device,
            ok: false,
            exitCode: null,
            timedOut: false,
            durationMs: 0,
            stdout: '',
            stderr: '',
            error: `skipped (fail-fast after ${firstFailure})`,
        }),
        isFailure: (entry) => !entry.ok,
    });

    if (devices.length === 0) {
        const suffix = args.group ? `, group="${args.group}"` : '';
        return {
            content: [
                {
                    type: 'text',
                    text: `No devices to run on (product="${args.product}"${suffix}).`,
                },
            ],
            isError: false,
        };
    }

    const okCount = entries.filter((e) => e.ok).length;
    const timedOutCount = entries.filter((e) => e.timedOut).length;
    const errorCount = entries.filter((e) => e.error).length;
    const failCount = entries.length - okCount - timedOutCount - errorCount;

    const lines = [];
    lines.push(
        `Ran \`${args.command}\` on ${entries.length} device(s) of product "${args.product}" ` +
            `(concurrency=${concurrency}, timeout=${timeout}s).\n`,
    );
    for (const e of entries) {
        const status = e.error
            ? `ERROR (${e.error})`
            : e.timedOut
              ? `TIMEOUT after ${timeout}s`
              : e.ok
                ? `OK exit=0`
                : `FAIL exit=${e.exitCode}`;
        lines.push(`--- ${e.device} [${status}] ${e.durationMs}ms ---`);
        if (e.stdout) lines.push(e.stdout.trimEnd());
        if (e.stderr) lines.push(`stderr: ${e.stderr.trimEnd()}`);
    }
    lines.push(
        `\nSummary: ${okCount} ok, ${failCount} failed, ${timedOutCount} timed out, ${errorCount} errored — ${durationMs}ms total`,
    );

    const anyFailure = failCount + timedOutCount + errorCount > 0;
    return {
        content: [{ type: 'text', text: lines.join('\n') }],
        isError: anyFailure,
    };
}

export const tools = [
    {
        name: 'thinr_products',
        description:
            'List all products configured on the server, with their device count and whether they have product-level scripts configured. Use this before assigning a device to a product with thinr_device_set_product, or before managing product scripts with thinr_product_script_*.',
        inputSchema: {
            type: 'object',
            properties: {
                user: { type: 'string', description: 'API user' },
            },
            required: [],
        },
        handler: toolProducts,
    },
    {
        name: 'thinr_product_delete',
        description:
            'Delete a product and, by default, its file storage with all scripts. Destructive: confirm with the user before calling. Any device currently assigned to the product is left as-is (unassigned from it by the server) — this tool does not touch the user-level monitoring bucket, which is shared across products.',
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID to delete.' },
                keep_storage: {
                    type: 'boolean',
                    description:
                        "When true, preserve the product's file storage (scripts + index.js). Default: false (also delete the storage).",
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product'],
        },
        handler: toolProductDelete,
    },
    {
        name: 'thinr_product_script_list',
        description: `List product-level scripts stored under the product's file storage, cross-referenced with the API resources they expose.

Product scripts are executable files kept in a per-product storage ("<product>") under scripts/. Each script file is exposed as a product API resource (same name without the extension) that can be invoked on any device of the product via thinr_resource_call. Compared to device-level scripts (thinr_script_*), product scripts scale to large fleets because the source of truth lives server-side and is downloaded inline on each invocation — no per-device deployment, no drift.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product'],
        },
        handler: toolProductScriptList,
    },
    {
        name: 'thinr_product_script_read',
        description: `Read the current content of a product script from the product storage. Useful to inspect or edit an existing script before rewriting it with thinr_product_script_write.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: {
                    type: 'string',
                    description:
                        'Script filename as stored under scripts/ (with extension if any, e.g. "backup.sh").',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'name'],
        },
        handler: toolProductScriptRead,
    },
    {
        name: 'thinr_product_script_write',
        description: `Install or replace a product-level script. Orchestrates everything transparently: creates the product's storage if missing, writes the generic index.js wrapper on first use, wires profile.code.storage, enables the product, uploads the script under scripts/<name>, and creates/updates the API resource so the script is immediately callable on any device of the product.

Script contract:
- Any executable source. If the body starts with a shebang (#!/usr/bin/env python3, #!/bin/bash, …) the agent materializes it to a temp file and runs it with the declared interpreter. Without a shebang, the body runs through the shell (pipes, redirects, && all work).
- Any object the caller sends when invoking the resource is forwarded to the script on stdin as JSON. Parse with jq / json.load / JSON.parse.
- When \`output\` is true (default), stdout must be valid JSON; it is parsed server-side (parse_stdout) so the resource returns the decoded object, not the raw shell output.

Pick \`input\` and \`output\` according to the resource shape:
- output-only (e.g. stats): omit \`input\`, leave \`output\` at its default. Resource classifies as fn=3 (output); frontend renders only the typed output.
- input+output (e.g. echo/transform): pass an \`input\` schema, leave \`output\` at its default. Resource classifies as fn=4 (input_output); frontend renders typed input fields AND the output.
- input-only (e.g. notify, log): pass an \`input\` schema and set \`output: false\`. Resource classifies as fn=2 (input); frontend renders only the input form and the call replies empty.
- run (e.g. ping, restart): omit \`input\` and set \`output: false\`. Resource classifies as fn=1 (run); just a button that fires the script.

\`input\` schema shape: a plain object mapping field names to default values (e.g. { "threshold": 80, "label": "warm" }). Declaring it registers a template_payload on the request side so the frontend renders typed input fields with those defaults and callers can override each field when invoking the resource. Field names must match /^[A-Za-z_][A-Za-z0-9_]*$/; values may be string, number or boolean. Omit \`input\` for a free-form payload where any object passed by the caller flows straight to stdin without a declared schema.

The file extension (.sh, .py, .js, …) is preserved in the storage for editor highlighting, but the API resource name is the stem without extension. So scripts/backup.sh is callable as the resource "backup".`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: {
                    type: 'string',
                    description:
                        'Script filename (e.g. "backup.sh"). The stem ("backup") becomes the API resource name.',
                },
                content: {
                    type: 'string',
                    description:
                        'Full script source code. Include a shebang to use a non-shell interpreter.',
                },
                icon: {
                    type: 'string',
                    description:
                        'Optional Font Awesome 5 icon class to use when the product is created (only applied on first write). Default: "fab fa-linux". Examples: "fab fa-apple", "fab fa-raspberry-pi", "fas fa-server".',
                },
                input: {
                    type: 'object',
                    description:
                        'Optional input schema: plain object mapping field names to default values. Registers a typed template so the frontend renders input fields. Field names must match /^[A-Za-z_][A-Za-z0-9_]*$/. Values may be string, number or boolean. Omit for a free-form payload.',
                    additionalProperties: true,
                },
                output: {
                    type: 'boolean',
                    description:
                        'Whether the resource returns data. Default true: stdout is parsed as JSON and returned (and exposed as the resource output in the frontend). Set to false for fire-and-forget scripts — the resource replies empty and, combined with no input, classifies as "run".',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'name', 'content'],
        },
        handler: toolProductScriptWrite,
    },
    {
        name: 'thinr_product_write',
        description: `Upload a file to every active device of a product in parallel. Content is passed inline as a UTF-8 string — the same contract as thinr_write, just fanned out.

Typical uses: rolling out a shared configuration file, pushing a small static asset, or seeding a script that devices load at boot. Offline devices are skipped by default; set \`all: true\` to attempt them too (they will typically fail fast with a connection error). \`concurrency\` bounds parallel uploads (default 10) and \`fail_fast\` stops dequeueing new devices after the first failure.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: {
                    type: 'string',
                    description: 'Product ID (discover with thinr_products).',
                },
                path: {
                    type: 'string',
                    description: 'Absolute path on each device where the file will be written.',
                },
                content: {
                    type: 'string',
                    description: 'UTF-8 file content to write on every device.',
                },
                group: {
                    type: 'string',
                    description: 'Optional asset group filter.',
                },
                concurrency: {
                    type: 'number',
                    description: 'Max parallel uploads (default: 10).',
                },
                fail_fast: {
                    type: 'boolean',
                    description:
                        'Stop dequeueing new devices as soon as one fails (default: false).',
                },
                all: {
                    type: 'boolean',
                    description:
                        'Include offline devices (default: false — only active are targeted).',
                },
                user: { type: 'string', description: 'API user (admin impersonation).' },
            },
            required: ['product', 'path', 'content'],
        },
        handler: toolProductWrite,
    },
    {
        name: 'thinr_product_exec',
        description: `Execute a shell command in parallel on every active device of a product, and return stdout, stderr, exit code and duration per device plus a consolidated summary.

Prefer this over iterating \`thinr_exec\` device-by-device when you need to roll out or inspect something across a fleet. Offline devices are skipped by default; pass \`all: true\` to attempt them anyway (they will typically fail fast with a connection error). \`concurrency\` bounds how many devices run at once (default 10), \`timeout\` is per-device in seconds (default 30), and \`fail_fast\` stops dequeueing new devices as soon as one returns a non-zero exit / times out — in-flight work still completes.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: {
                    type: 'string',
                    description: 'Product ID (discover with thinr_products).',
                },
                command: {
                    type: 'string',
                    description: 'Shell command to run on each device.',
                },
                group: {
                    type: 'string',
                    description:
                        'Optional asset group filter — restricts execution to devices in this group.',
                },
                concurrency: {
                    type: 'number',
                    description: 'Max parallel executions (default: 10).',
                },
                timeout: {
                    type: 'number',
                    description: 'Per-device timeout in seconds (default: 30).',
                },
                fail_fast: {
                    type: 'boolean',
                    description:
                        'Stop dequeueing new devices as soon as one fails (default: false).',
                },
                all: {
                    type: 'boolean',
                    description:
                        'Include offline devices (default: false — only active devices are targeted).',
                },
                user: { type: 'string', description: 'API user (admin impersonation).' },
            },
            required: ['product', 'command'],
        },
        handler: toolProductExec,
    },
    {
        name: 'thinr_product_script_delete',
        description: `Remove a product script: deletes the file under scripts/ in the product storage and the associated API resource.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: {
                    type: 'string',
                    description:
                        'Script filename as stored under scripts/ (with extension if any).',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'name'],
        },
        handler: toolProductScriptDelete,
    },
    {
        name: 'thinr_product_property_get',
        description: `Read a product-level property (not a device property). Product properties are structured JSON values attached to the product itself — typical uses include dashboard configuration, shared feature flags, or the list of dashboard metrics managed by thinr_product_metric_*. Call without \`property\` to list the names of every property configured on the product.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                property: {
                    type: 'string',
                    description:
                        'Property name. Omit to list the names of all properties on the product.',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product'],
        },
        handler: toolProductPropertyGet,
    },
    {
        name: 'thinr_product_property_set',
        description: `Create or overwrite a product-level property. The value can be any JSON-serialisable shape (string, number, object, array). Existing properties are replaced wholesale; missing ones are created. Prefer the higher-level thinr_product_metric_* tools when managing dashboard metrics — they encapsulate the property shape so you don't have to reconstruct it by hand.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                property: { type: 'string', description: 'Property name to create or overwrite.' },
                value: {
                    description:
                        'Any JSON-serialisable value (string, number, boolean, object, array).',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'property', 'value'],
        },
        handler: toolProductPropertySet,
    },
    {
        name: 'thinr_product_property_delete',
        description: `Delete a product-level property. Idempotent — returns success even if the property was not set.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                property: { type: 'string', description: 'Property name to delete.' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'property'],
        },
        handler: toolProductPropertyDelete,
    },
    {
        name: 'thinr_product_metric_list',
        description: `List the dashboard metrics configured on a product. Each metric describes a value the dashboard should stream (resource to poll, aggregation, visualization, refresh interval). Metrics are stored under the \`${DASHBOARD_METRICS_PROPERTY}\` product property.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product'],
        },
        handler: toolProductMetricList,
    },
    {
        name: 'thinr_product_metric_set',
        description: `Add or update a dashboard metric on a product. Metrics are identified by their stable \`name\` key: reusing an existing name updates that entry in place, otherwise a new one is appended. Under the hood this edits the \`${DASHBOARD_METRICS_PROPERTY}\` product property — prefer this tool over thinr_product_property_set for dashboard metrics so the shape stays consistent.

Typical flow: create a product script that returns the raw data (thinr_product_script_write), then register the metric so the dashboard knows how to surface it.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: {
                    type: 'string',
                    description:
                        'Stable identifier for the metric (letters, digits, underscore, dash). Reusing a name updates the existing entry.',
                },
                label: {
                    type: 'string',
                    description: 'Human-readable label shown in the dashboard panel.',
                },
                resource: {
                    type: 'string',
                    description:
                        'Product API resource the dashboard invokes per device to get the value (e.g. the stem of a product script).',
                },
                field: {
                    type: 'string',
                    description:
                        'Dot-path into the resource response pointing at the numeric value to aggregate (e.g. "connections.devices"). Omit for scalar responses.',
                },
                aggregation: {
                    type: 'string',
                    description:
                        'How to combine the per-device values across the fleet: sum, avg, max, min, count, top, none.',
                    enum: ['sum', 'avg', 'max', 'min', 'count', 'top', 'none'],
                },
                visualization: {
                    type: 'string',
                    description:
                        'Dashboard rendering hint. "kpi" (default) shows the aggregated value plus its age. "sparkline" renders the same value alongside a ▁▂▃▅▇ bar of the last ~32 samples, useful for metrics where the trend matters (throughput, connected devices). "bar" and "list" are reserved for future use and currently fall back to kpi.',
                    enum: ['kpi', 'bar', 'sparkline', 'list'],
                },
                interval: {
                    type: 'number',
                    description:
                        'Refresh interval in seconds the dashboard should subscribe with. Minimum: 1. Omit (or set to 0) to subscribe without a server-side poll — the stream then only relays values the device pushes on its own.',
                },
                unit: {
                    type: 'string',
                    description: 'Optional unit suffix for display (e.g. "%", "devices").',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'name', 'resource'],
        },
        handler: toolProductMetricSet,
    },
    {
        name: 'thinr_product_metric_delete',
        description: `Remove a dashboard metric from a product by its \`name\`. If it was the last metric configured, the underlying \`${DASHBOARD_METRICS_PROPERTY}\` product property is removed entirely.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: { type: 'string', description: 'Metric name previously registered.' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'name'],
        },
        handler: toolProductMetricDelete,
    },
    {
        name: 'thinr_product_playbook_list',
        description: `List the playbooks registered on a product, with their description and storage path. Use this to discover available playbooks before reading or running them; pair with thinr_product_playbook_read when you need the full YAML of a specific entry. Returns an empty listing if the product has no \`playbooks\` index property yet.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product'],
        },
        handler: toolProductPlaybookList,
    },
    {
        name: 'thinr_product_playbook_read',
        description: `Return the raw YAML source of a single playbook stored on a product. Use this when you need the full document (to review it, edit and re-upload, or hand the content to thinr_playbook_run). For just the catalogue of available entries use thinr_product_playbook_list — it is cheaper and does not download each file.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: {
                    type: 'string',
                    description:
                        'Playbook name as registered in the product index (letters, digits, underscore, dash — no extension).',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'name'],
        },
        handler: toolProductPlaybookRead,
    },
    {
        name: 'thinr_product_playbook_write',
        description: `Create or replace a playbook on a product. The YAML content is passed inline and validated against the playbook schema before upload; an invalid document fails fast with a descriptive error and nothing is written. If a playbook with the same name already exists, it is overwritten in place. The upload writes the file under \`playbooks/<name>.yaml\` in the product storage first, then registers the entry in the \`playbooks\` product property — a failure mid-way rolls the file back so the index never points at a missing file.

Name rules: letters, digits, underscore, dash — no extension, no slashes. Description is optional; when omitted, the playbook's own \`description\` field (if any) is recorded in the index. Prefer calling thinr_playbook_schema first when authoring a playbook from scratch so the YAML validates on the first write.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: {
                    type: 'string',
                    description:
                        'Playbook name (letters, digits, underscore, dash). Used as the key in the product index and as the filename under `playbooks/`.',
                },
                content: {
                    type: 'string',
                    description:
                        'Full YAML source of the playbook. Validated before upload unless skip_validation is true.',
                },
                description: {
                    type: 'string',
                    description:
                        "Optional description stored alongside the index entry. When omitted, falls back to the playbook's own `description` field.",
                },
                skip_validation: {
                    type: 'boolean',
                    description:
                        'Skip playbook schema validation before uploading (default: false). Use sparingly — an invalid document will still fail at run time.',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'name', 'content'],
        },
        handler: toolProductPlaybookWrite,
    },
    {
        name: 'thinr_product_playbook_run',
        description: `Run a playbook stored on a product against a single device — the safe pre-flight before rolling out across a fleet. Downloads the playbook by name, seeds variables from the playbook's declared defaults, applies any overrides supplied in \`vars\`, validates them (unknown / non-overridable / wrong-type / missing-required all surface as errors), and executes every step against \`device\`.

Pass \`dry_run: true\` to get the resolved plan without contacting the device. Pass \`check: true\` to contact the device read-only and report what each step would change. Overrides never mutate the stored playbook — they are per-invocation only. Use this tool before \`thinr_playbook_run\` (fleet mode) to validate behaviour on a single device first.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: {
                    type: 'string',
                    description: 'Playbook name as registered in the product index.',
                },
                device: {
                    type: 'string',
                    description: 'Target device ID (single-device only). Pick any device of the product.',
                },
                vars: {
                    type: 'object',
                    description:
                        'Per-invocation variable overrides keyed by variable name. Values must match the declared type; unknown / non-overridable names are rejected.',
                    additionalProperties: true,
                },
                dry_run: {
                    type: 'boolean',
                    description:
                        'Return the resolved plan (variables + step summaries) without contacting the device (default: false).',
                },
                check: {
                    type: 'boolean',
                    description:
                        'Contact the device read-only and report what each step would change, without writing (default: false).',
                },
                user: { type: 'string', description: 'API user (admin impersonation).' },
            },
            required: ['product', 'name', 'device'],
        },
        handler: toolProductPlaybookRun,
    },
    {
        name: 'thinr_product_playbook_rollout',
        description: `Roll a playbook stored on a product across every matching device, progressively and with safety rails. Devices are attempted in discrete batches of \`batch_size\`; a batch completes fully before the next starts. After each batch the cumulative failure rate is compared against \`failure_threshold\` — reaching it aborts the rollout without touching the remaining devices.

Destructive: prefer running \`thinr_product_playbook_run\` on a single device first to validate behaviour. Variables resolve the same way (declared defaults + \`vars\` overrides, validated against declared types; unknown / non-overridable / missing-required all rejected). The rollout writes a persistent report to \`playbooks/runs/<timestamp>-<name>-<user>.json\` in the product file storage, capturing the resolved variables, per-device outcome, and stop reason if aborted — best-effort, a failed upload is reported but does not fail the rollout.

Filtering: \`group\` restricts to an asset group; \`filter\` passes extra server-side key=value filters (repeatable keys only — letters/digits/underscore). By default only active devices are targeted; pass \`include_offline: true\` to attempt offline ones too.

Use \`dry_run: true\` to get the resolved plan and the list of devices that would be targeted without contacting any of them. \`check: true\` contacts devices read-only and reports what each step would change, without writing.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: {
                    type: 'string',
                    description: 'Playbook name as registered in the product index.',
                },
                batch_size: {
                    type: 'number',
                    description:
                        'Devices attempted in parallel per batch. Next batch starts only after the current one finishes. Default: 5.',
                },
                failure_threshold: {
                    type: 'number',
                    description: `Abort rollout when cumulative failure rate (percentage of attempted devices that failed) reaches this value. Must be between 0 and 100. Default: ${DEFAULT_FAILURE_THRESHOLD}.`,
                },
                group: {
                    type: 'string',
                    description:
                        'Restrict to devices in this asset group. Combined with `filter` if both are set.',
                },
                filter: {
                    type: 'object',
                    description:
                        'Extra server-side filters passed as query params when listing devices. Keys must match [A-Za-z0-9_]+. Typical uses: narrowing by device field.',
                    additionalProperties: { type: 'string' },
                },
                include_offline: {
                    type: 'boolean',
                    description:
                        'Include offline devices in the rollout (default: false — only active devices are attempted).',
                },
                vars: {
                    type: 'object',
                    description:
                        'Per-invocation variable overrides applied to every device. Values must match the declared type; unknown / non-overridable names are rejected.',
                    additionalProperties: true,
                },
                dry_run: {
                    type: 'boolean',
                    description:
                        'Return the resolved plan and target devices without contacting any of them (default: false).',
                },
                check: {
                    type: 'boolean',
                    description:
                        'Contact devices read-only and report what each step would change, without writing (default: false).',
                },
                user: { type: 'string', description: 'API user (admin impersonation).' },
            },
            required: ['product', 'name'],
        },
        handler: toolProductPlaybookRollout,
    },
    {
        name: 'thinr_product_playbook_delete',
        description: `Remove a playbook from a product: first unregisters it from the \`playbooks\` index property, then deletes the underlying \`playbooks/<name>.yaml\` file from the product storage. Idempotent — calling it on a missing playbook reports success without erroring.`,
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: {
                    type: 'string',
                    description: 'Playbook name previously registered on the product.',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'name'],
        },
        handler: toolProductPlaybookDelete,
    },
];
