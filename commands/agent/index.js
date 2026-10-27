// @ts-check
import { printErr } from '@thinger-io/cli-core/output';
import { applyJsonFlag, ensureConfigured, getGlobalUser, parsePositiveInt } from '../_shared.js';
import { runDeviceUpdate } from './device.js';
import { runFleetUpdate } from './fleet.js';

/**
 * `thinr agent check|update` — the ThinRemote agent on the devices: check
 * whether a device has a newer release, and update one device or, with
 * `--all`, every outdated device of the fleet (narrowed by product or asset
 * group), a canary first and then in batches.
 */
export function agentCommand(program) {
    const agent = program
        .command('agent')
        .helpGroup('Operations:')
        .description('The ThinRemote agent of the devices: check for and apply its updates');

    agent
        .command('check <device>')
        .helpGroup('Updates:')
        .description('Check whether a newer agent release is available for a device')
        .option('--channel <name>', 'Release channel', 'latest')
        .option('-j, --json', 'Output as JSON')
        .action(async (device, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            await runDeviceUpdate('check', device, opts, getGlobalUser(cmd));
        });

    agent
        .command('update [device]')
        .helpGroup('Updates:')
        .description(
            'Update the agent of a device, or with --all of every outdated device of the fleet',
        )
        .option('--channel <name>', 'Release channel', 'latest')
        .option('--all', 'Every outdated device of the fleet (narrow it with -p and -g)')
        .option('-p, --product <id>', 'With --all: only the devices of this product')
        .option('-g, --group <id>', 'With --all: only the devices of this asset group')
        .option(
            '--batch-size <n>',
            'With --all: devices updated in parallel once the canary passes',
            parsePositiveInt('batch-size'),
            5,
        )
        .option('--no-canary', 'With --all: no canary phase (everything in batches from the start)')
        .option('--continue-on-error', 'With --all: keep rolling after a batch failure')
        .option('--dry-run', 'With --all: list what would be updated, without updating it')
        .option('-y, --yes', 'With --all: no confirmation (required in non-interactive shells)')
        .option('-j, --json', 'Output as JSON')
        .action(async (device, opts, cmd) => {
            applyJsonFlag(opts);
            ensureConfigured();
            const user = getGlobalUser(cmd);
            if (device && opts.all) {
                printErr('give a device or --all, not both', { code: 'input_error' });
                return;
            }
            if (!device && !opts.all) {
                printErr('give a device, or --all for every outdated device of the fleet', {
                    code: 'input_error',
                });
                return;
            }
            if (opts.all) return runFleetUpdate(opts, user);
            const fleetOnly = ['product', 'group', 'dryRun', 'continueOnError'].filter(
                (o) => opts[o] !== undefined,
            );
            if (fleetOnly.length || opts.canary === false) {
                printErr(
                    `--product, --group, --dry-run, --continue-on-error and --no-canary go with --all (to check one device: agent check ${device})`,
                    { code: 'input_error' },
                );
                return;
            }
            await runDeviceUpdate('apply', device, opts, user);
        });
}
