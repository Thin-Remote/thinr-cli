// @ts-check
import { registerProductPropertyCommand } from './property.js';
import { registerProductMetricCommands } from './metric.js';
import { registerProductResourceCommand } from './resource.js';
import { registerProductExecCommand } from './exec.js';
import { registerProductStatusCommand } from './status.js';
import { registerProductFsCommands } from './fs.js';
import { registerProductPushCommand } from './push.js';
import { registerProductPlaybookCommand } from './playbook.js';
import { registerProductLogsCommand } from './logs.js';

/**
 * `thinr product <verb> <product> …` — fan-out commands across every device
 * that belongs to a product (status, exec, files, device-property,
 * device-resource), plus its metrics, log sources and playbooks, added to
 * the generic `product` group of @thinger-io/cli-core (records,
 * properties, profile, export, apply).
 */
export function registerProductCommands(product) {
    registerProductStatusCommand(product);
    registerProductPropertyCommand(product);
    registerProductMetricCommands(product);
    registerProductResourceCommand(product);
    registerProductExecCommand(product);
    registerProductFsCommands(product);
    registerProductPushCommand(product);
    registerProductPlaybookCommand(product);
    registerProductLogsCommand(product);
}
