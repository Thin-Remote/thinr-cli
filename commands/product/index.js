// @ts-check
import { registerProductListCommand } from './list.js';
import { registerProductPropertyCommand } from './property.js';
import { registerProductResourceCommand } from './resource.js';
import { registerProductExecCommand } from './exec.js';
import { registerProductStatusCommand } from './status.js';
import { registerProductFsCommands } from './fs.js';
import { registerProductPushCommand } from './push.js';

/**
 * `thinr product <subcommand> <productId> …` — fan-out commands across
 * every device that belongs to a product.
 */
export function productCommand(program) {
    const product = program
        .command('product')
        .helpGroup('Operations:')
        .description('Product commands (subcommand-first: thinr product <action> <productId>)');

    registerProductListCommand(product);
    registerProductStatusCommand(product);
    registerProductPropertyCommand(product);
    registerProductResourceCommand(product);
    registerProductExecCommand(product);
    registerProductFsCommands(product);
    registerProductPushCommand(product);
}
