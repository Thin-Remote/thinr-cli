// @ts-check
import {
    getProductProperties,
    getProductProperty,
    setProductProperty,
    deleteProductProperty,
} from '../../lib/product.js';
import { info, success } from '../../lib/format.js';
import { isJsonMode, printOk, printErr, classifyError } from '../../lib/output.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from '../_shared.js';

function parseJsonValue(raw) {
    if (raw == null) return raw;
    try {
        return JSON.parse(raw);
    } catch {
        // Fall back to raw string so `thinr product property-set p x foo` still works
        // for trivial scalar writes without shell-escaping quotes.
        return raw;
    }
}

export function registerProductPropertyAdminCommands(product) {
    product
        .command('property-list <productId>')
        .helpGroup('Product config:')
        .description('List the names of properties attached to a product')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            try {
                const list = await getProductProperties(productId, user);
                const names = Array.isArray(list) ? list.map((p) => p.property).filter(Boolean) : [];
                if (isJsonMode()) {
                    printOk({ product: productId, properties: names });
                    return;
                }
                if (names.length === 0) {
                    console.log(`No properties on product ${info(productId)}`);
                    return;
                }
                console.log(`Properties of product ${info(productId)}:`);
                for (const n of names) console.log(`- ${n}`);
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });

    product
        .command('property-get <productId> <propertyId>')
        .helpGroup('Product config:')
        .description('Read a property attached to a product')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, propertyId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            try {
                const value = await getProductProperty(productId, propertyId, user);
                if (isJsonMode()) {
                    printOk({ product: productId, property: propertyId, value });
                    return;
                }
                console.log(`Value of ${info(propertyId)} on product ${info(productId)}:`);
                console.log(JSON.stringify(value, null, 2));
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });

    product
        .command('property-set <productId> <propertyId> <value>')
        .helpGroup('Product config:')
        .description('Create or overwrite a product property (value parsed as JSON)')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, propertyId, value, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const parsed = parseJsonValue(value);
            try {
                const saved = await setProductProperty(productId, propertyId, parsed, user);
                if (isJsonMode()) {
                    printOk({ product: productId, property: propertyId, value: saved.value });
                    return;
                }
                console.log(
                    `Saved property ${info(propertyId)} on product ${info(productId)} → ${success(JSON.stringify(saved.value))}`,
                );
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });

    product
        .command('property-delete <productId> <propertyId>')
        .helpGroup('Product config:')
        .description('Delete a product property (idempotent)')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, propertyId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            try {
                const removed = await deleteProductProperty(productId, propertyId, user);
                if (isJsonMode()) {
                    printOk({ product: productId, property: propertyId, removed });
                    return;
                }
                console.log(
                    removed
                        ? `Deleted ${info(propertyId)} from ${info(productId)}`
                        : `Property ${info(propertyId)} was not set on ${info(productId)}`,
                );
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });
}
