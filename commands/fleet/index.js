// @ts-check
import { registerUpgradeCommand } from './upgrade.js';

/**
 * `thinr fleet <subcommand>` — operations that treat the whole device
 * fleet as the unit of work, not a single device. Today we only expose
 * `upgrade`; future fan-out commands (status summary, health probe,
 * rollback, etc.) would live alongside it.
 */
export function fleetCommand(program) {
    const fleet = program
        .command('fleet')
        .helpGroup('Operations:')
        .description('Fleet-wide commands (run once, touch many devices)');

    registerUpgradeCommand(fleet);
}
