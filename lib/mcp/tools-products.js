// @ts-check
import {
    getProducts,
    deleteProductWithStorage,
    installProductScript,
    removeProductScript,
    listProductScripts,
    readProductScript,
    getProductApi,
} from '../product.js';
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
