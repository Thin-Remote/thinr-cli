// @ts-check
import { readFileSync, writeFileSync } from 'fs';
import Table from 'cli-table3';
import {
    deleteProductPlaybook,
    listProductPlaybooks,
    readProductPlaybook,
    uploadProductPlaybook,
} from '../../lib/product.js';
import { hint, info, label, muted, success, warning } from '../../lib/format.js';
import { classifyError, createSpinner, isJsonMode, printErr, printOk } from '../../lib/output.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from '../_shared.js';

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

export function registerProductPlaybookCommand(product) {
    const playbook = product
        .command('playbook')
        .helpGroup('Playbooks:')
        .description(
            `Manage playbooks stored on a product. ${hint('Subcommands: list, upload, download, delete.')}`,
        );

    registerList(playbook);
    registerUpload(playbook);
    registerDownload(playbook);
    registerDelete(playbook);
}
