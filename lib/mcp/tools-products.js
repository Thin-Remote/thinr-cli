// @ts-check
import { Buffer } from 'node:buffer';
import {
    installProductScript,
    removeProductScript,
    listProductScripts,
    readProductScript,
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
import { requireConfig } from '@thinger-io/cli-core/config';
import { filterActiveDevices, getDevices } from '@thinger-io/cli-core/devices';
import { parsePlaybook } from '../playbook/loader.js';
import { buildDryRunPlan, runPlaybook } from '../playbook/runner.js';
import { DEFAULT_FAILURE_THRESHOLD, runFleetPlaybook } from '../playbook/fleet.js';
import { listVariables, resolveVarScope } from '../playbook/vars.js';
import { inputError } from '@thinger-io/cli-core/errors';
import { toolName } from '@thinger-io/cli-core/mcp/naming';

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
        input: args.input,
        output: args.output,
    });
    const lines = [
        `Installed product script "${args.name}" on "${args.product}".`,
        `Steps:`,
        ...steps.map((s) => `  - ${s}`),
        `Invoke on any device of this product with ${toolName('device_resource_call')}(device=<id>, resource="${stem}", inputs={input: {...}}).`,
    ];
    return {
        content: [{ type: 'text', text: lines.join('\n') }],
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
    if (!args.device_id) throw inputError('device is required (single-device only)');

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

    pb.target.devices = [args.device_id];
    pb.target.product = args.product;
    pb.target.group = null;

    if (args.dry_run) {
        const plan = buildDryRunPlan(pb, { overrides: rawVars });
        const payload = {
            dry_run: true,
            product: args.product,
            name: args.name,
            device: args.device_id,
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
    const device = all.find((d) => d.device === args.device_id) || {
        device: args.device_id,
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
        device: args.device_id,
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
        Number.isFinite(args.batch_size) && args.batch_size > 0 ? Math.floor(args.batch_size) : 5;
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
        name: 'product_script_list',
        description:
            'List a product\'s scripts (in its storage, under scripts/) and the API resources they expose; orphans have no resource. See {tool:doc_read} id "thinremote-scripts".',
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
        name: 'product_script_read',
        description: `Read the current content of a product script from the product storage. Useful to inspect or edit an existing script before rewriting it with {tool:product_script_write}.`,
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
        name: 'product_script_write',
        description:
            'Upsert a product script: code that runs on any device of the product, kept once in the product\'s storage and exposed as a product API resource named after the file (scripts/backup.sh → "backup"), callable at once with {tool:device_resource_call}. Sets up everything it needs (storage, wrapper, product code, API resource). The product must exist. The script gets the caller\'s input on stdin as JSON and must print JSON on stdout unless `output` is false; `input` declares typed fields with defaults. Contract, resource shapes and examples: {tool:doc_read} id "thinremote-scripts".',
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
        name: 'product_write',
        description:
            'Write a file (inline UTF-8 content) to every active device of a product in parallel, like {tool:device_file_write} fanned out. Offline devices are skipped unless `all`; `concurrency` (default 10), `fail_fast`.',
        inputSchema: {
            type: 'object',
            properties: {
                product: {
                    type: 'string',
                    description:
                        'Product ID (discover with {tool:resource_list} (type "product")).',
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
        name: 'product_exec',
        description:
            'Run a shell command in parallel on every active device of a product; returns stdout, stderr, exit code and duration per device plus a summary. Use instead of looping {tool:device_exec}. Offline devices are skipped unless `all`; `concurrency` (default 10), per-device `timeout` (default 30 s), `fail_fast` stops starting new devices after a failure. For repeatable, checked changes use a playbook.',
        inputSchema: {
            type: 'object',
            properties: {
                product: {
                    type: 'string',
                    description:
                        'Product ID (discover with {tool:resource_list} (type "product")).',
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
        name: 'product_script_delete',
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
        name: 'product_metric_list',
        description: "List a product's dashboard metrics (the `dashboard_metrics` property).",
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
        name: 'product_metric_write',
        description:
            'Upsert a dashboard metric on a product: a value the dashboard asks every device for (a product API resource, usually a product script) and combines across the fleet with `aggregation`. Reusing `name` updates it. Use this rather than editing the `dashboard_metrics` property. Fields and recipe: {tool:doc_read} id "thinremote-product-dashboard".',
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
                        'How to combine the per-device values across the fleet. Numeric reducers: "sum", "avg", "max", "min". "count" returns the number of devices reporting any non-null value, irrespective of value. "top" lists the values without counting repetitions. "none" returns the raw per-device array. "distribution" returns a flat object mapping each distinct reported value (coerced to string) to the number of devices reporting it — use it for categorical data such as agent version, release/branch, kernel, hostname pattern; it is the right choice when the question is "how is the fleet split across these values?". The output of "distribution" is an object value→count, not a number; the dashboard renders it as a sorted list with per-value percentages and a total row.',
                    enum: ['sum', 'avg', 'max', 'min', 'count', 'top', 'none', 'distribution'],
                },
                visualization: {
                    type: 'string',
                    description:
                        'Dashboard rendering hint. "kpi" (default) shows the aggregated value plus its age. "sparkline" renders the same value alongside a ▁▂▃▅▇ bar of the last ~32 samples, useful for metrics where the trend matters (throughput, connected devices). "list" pairs naturally with aggregation "distribution" — it lays out each value as its own row with count and percentage, plus a total. "bar" is reserved for future use and currently falls back to kpi.',
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
        name: 'product_metric_delete',
        description: 'Remove a dashboard metric from a product by name.',
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
        name: 'product_playbook_list',
        description: 'List the playbooks saved on a product (name, description, path).',
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
        name: 'product_playbook_read',
        description: 'Return the YAML of a playbook saved on a product, to review or edit it.',
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
        name: 'product_playbook_write',
        description:
            'Upsert a playbook on a product from inline YAML. It is validated first and nothing is written if invalid (fix the YAML; never skip validation). Draft with {tool:playbook_describe} and {tool:playbook_validate}, then save here, then try it with {tool:product_playbook_run}. Names: letters, digits, _ and -. Flow and format: {tool:doc_read} id "thinremote-playbooks".',
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
                        'Escape hatch for rare cases where the schema cannot yet express a field the runtime already accepts (default: false). Do NOT set this to work around a validation error reported by {tool:playbook_validate} — fix the YAML instead. An invalid document will still fail at run time.',
                },
                user: { type: 'string', description: 'API user' },
            },
            required: ['product', 'name', 'content'],
        },
        handler: toolProductPlaybookWrite,
    },
    {
        name: 'product_playbook_run',
        description:
            "Run a product's playbook on one device: the pre-flight before {tool:product_playbook_rollout}. Seeds the playbook's variable defaults, applies and validates `vars` overrides (never stored). `dry_run` returns the resolved plan without contacting the device; `check` contacts it read-only and reports what each step would change.",
        inputSchema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'Product ID.' },
                name: {
                    type: 'string',
                    description: 'Playbook name as registered in the product index.',
                },
                device_id: {
                    type: 'string',
                    description:
                        'Target device ID (single-device only). Pick any device of the product.',
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
            required: ['product', 'name', 'device_id'],
        },
        handler: toolProductPlaybookRun,
    },
    {
        name: 'product_playbook_rollout',
        description:
            'Roll a product\'s playbook out across its devices in batches of `batch_size`, stopping when the cumulative failure rate reaches `failure_threshold`. Destructive: confirm with the user and test with {tool:product_playbook_run} on one device first. `dry_run` lists plan and devices; `check` reports what would change without writing. Narrow with `group` / `filter`; offline devices are skipped unless `include_offline`. Writes a report to playbooks/runs/ in the product storage. Details: {tool:doc_read} id "thinremote-playbooks".',
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
        name: 'product_playbook_delete',
        description: 'Delete a playbook from a product (index entry and file). Idempotent.',
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
