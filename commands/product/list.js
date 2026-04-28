// @ts-check
import { getProducts, getProductApi } from '../../lib/product.js';
import { runPool } from '../../lib/concurrency.js';
import { label, hint, success } from '../../lib/format.js';
import {
    isJsonMode,
    printOk,
    printErr,
    createSpinner,
    classifyError,
} from '../../lib/output.js';
import {
    applyJsonFlag,
    ensureConfigured,
    getGlobalUser,
    parsePositiveInt,
} from '../_shared.js';

export function registerProductListCommand(product) {
    product
        .command('list')
        .helpGroup('Discovery:')
        .description('List every product configured on the server')
        .option('-j, --json', 'Output as JSON')
        .option(
            '-c, --concurrency <n>',
            'Max parallel api-resource lookups (default: 10)',
            parsePositiveInt('concurrency'),
            10,
        )
        .action(async (opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);

            const spinner = createSpinner('Fetching products...').start();
            let products;
            try {
                products = await getProducts(user);
            } catch (error) {
                spinner.fail('Failed to fetch products');
                const { message, code } = classifyError(error);
                printErr(message, { code });
                return;
            }

            // Script counts come from each product's api resources map.
            // Parallelise so a large catalogue doesn't crawl serially.
            const scriptResults = await runPool(products, opts.concurrency, async (p) => {
                try {
                    const apis = await getProductApi(p.product, user);
                    return Object.keys(apis || {}).length;
                } catch {
                    return null;
                }
            });
            const rows = products.map((p, i) => ({
                product: p.product,
                name: p.name && p.name !== p.product ? p.name : null,
                enabled: !!p.enabled,
                scripts: scriptResults[i]?.ok ? scriptResults[i].value : null,
            }));

            spinner.succeed(`Found ${rows.length} product(s)`);

            if (isJsonMode()) {
                printOk({ products: rows });
                return;
            }

            if (rows.length === 0) return;

            // Pad the product id column so the trailing name/scripts
            // bits align even when ids have very different widths.
            const idWidth = rows.reduce((w, r) => Math.max(w, r.product.length), 0);
            for (const r of rows) {
                const flag = r.enabled ? success('enabled ') : hint('disabled');
                const id = label(r.product.padEnd(idWidth));
                const name = r.name ? hint(`(${r.name})`) : '';
                const scripts =
                    r.scripts != null && r.scripts > 0 ? hint(`${r.scripts} script(s)`) : '';
                const extras = [name, scripts].filter(Boolean).join('  ');
                console.log(`  ${flag}  ${id}${extras ? '  ' + extras : ''}`);
            }
        });
}
