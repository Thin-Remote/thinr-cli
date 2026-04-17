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
} from '../product.js';
import { createDeviceAPI } from '../device-api.js';
import { TIMEOUTS } from '../constants.js';
import { runProductFanOut } from '../product-orchestrator.js';
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
- The caller's optional "input" object is forwarded to the script on stdin as JSON. Parse with jq / json.load / JSON.parse.
- Stdout/stderr/exit code are returned in the response.

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
];
