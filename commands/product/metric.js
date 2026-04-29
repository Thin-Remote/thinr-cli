// @ts-check
import {
    listDashboardMetrics,
    upsertDashboardMetric,
    removeDashboardMetric,
} from '../../lib/product.js';
import { info, success } from '../../lib/format.js';
import { isJsonMode, printOk, printErr, classifyError } from '../../lib/output.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from '../_shared.js';

function stringifyMetricLine(m) {
    const parts = [
        `resource=${m.resource}`,
        m.field ? `field=${m.field}` : null,
        m.aggregation ? `agg=${m.aggregation}` : null,
        m.visualization ? `viz=${m.visualization}` : null,
        m.interval ? `every ${m.interval}s` : null,
    ].filter(Boolean);
    const trail = m.label ? `  · ${m.label}` : '';
    return `${m.name}  ${parts.join('  ')}${trail}`;
}

export function registerProductMetricCommands(product) {
    product
        .command('metric-list <productId>')
        .helpGroup('Product config:')
        .description('List dashboard metrics configured on a product')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            try {
                const metrics = await listDashboardMetrics(productId, user);
                if (isJsonMode()) {
                    printOk({ product: productId, metrics });
                    return;
                }
                if (metrics.length === 0) {
                    console.log(`No dashboard metrics configured on ${info(productId)}`);
                    return;
                }
                console.log(`${metrics.length} metric(s) on ${info(productId)}:`);
                for (const m of metrics) console.log('  - ' + stringifyMetricLine(m));
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });

    product
        .command('metric-set <productId> <name>')
        .helpGroup('Product config:')
        .description('Add or update a dashboard metric on a product')
        .requiredOption('-r, --resource <resource>', 'Product API resource the dashboard invokes')
        .option('-l, --label <label>', 'Human-readable label for the metric')
        .option('-f, --field <field>', 'Dot-path to the numeric value inside the response')
        .option(
            '-a, --aggregation <agg>',
            'Aggregation across the fleet (sum, avg, max, min, count, top, none, distribution)',
        )
        .option(
            '-v, --visualization <viz>',
            'Dashboard rendering hint (kpi, bar, sparkline, list)',
        )
        .option('-i, --interval <seconds>', 'Dashboard refresh interval in seconds', Number)
        .option('--unit <unit>', 'Unit suffix for display (e.g. "%", "devices")')
        .option('--json', 'Output as JSON')
        .action(async (productId, name, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            const metric = {
                name,
                label: opts.label,
                resource: opts.resource,
                field: opts.field,
                aggregation: opts.aggregation,
                visualization: opts.visualization,
                interval: opts.interval,
                unit: opts.unit,
            };
            for (const k of Object.keys(metric)) if (metric[k] === undefined) delete metric[k];
            try {
                const { action, count } = await upsertDashboardMetric(productId, metric, user);
                if (isJsonMode()) {
                    printOk({ product: productId, action, metric, total: count });
                    return;
                }
                console.log(
                    `Metric ${info(name)} ${success(action)} on ${info(productId)} (total: ${count}).`,
                );
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });

    product
        .command('metric-delete <productId> <name>')
        .helpGroup('Product config:')
        .description('Remove a dashboard metric from a product')
        .option('-j, --json', 'Output as JSON')
        .action(async (productId, name, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            try {
                const { action, count } = await removeDashboardMetric(productId, name, user);
                if (isJsonMode()) {
                    printOk({ product: productId, action, remaining: count });
                    return;
                }
                console.log(
                    action === 'removed'
                        ? `Removed ${info(name)} from ${info(productId)} (remaining: ${count}).`
                        : `Metric ${info(name)} was not configured on ${info(productId)}.`,
                );
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code });
            }
        });
}
