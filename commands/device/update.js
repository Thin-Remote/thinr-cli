// @ts-check
import chalk from 'chalk';
import { createDeviceAPI } from '../../lib/device-api.js';
import { isJsonMode, printOk, printErr, createSpinner, classifyError } from '../../lib/output.js';
import { applyJsonFlag, ensureConfigured, getGlobalUser } from './_shared.js';

const runUpdate = async (action, deviceId, opts, cmd) => {
    applyJsonFlag(opts);
    ensureConfigured();
    const user = getGlobalUser(cmd);
    const channel = opts.channel || 'latest';
    const label = action === 'check' ? 'Checking for updates' : 'Applying update';
    const spinner = createSpinner(`${label} on ${deviceId}...`).start();
    try {
        const api = createDeviceAPI(deviceId, { user });
        const timeout = action === 'apply' ? 300000 : 30000;
        const result = await api.callResource('update', { action, channel }, { timeout });
        spinner.succeed(`${label} finished`);
        if (isJsonMode()) {
            printOk(result);
        } else if (result && typeof result === 'object') {
            if (result.current) console.log(`  current: ${chalk.bold(result.current)}`);
            if (result.latest) console.log(`  latest:  ${chalk.bold(result.latest)}`);
            if (result.arch) console.log(`  arch:    ${result.arch}`);
            if (result.status) console.log(`  status:  ${chalk.cyan(result.status)}`);
            if (result.message) console.log(`  message: ${result.message}`);
        } else {
            console.log(result);
        }
    } catch (error) {
        spinner.fail(`${label} failed`);
        const { message, code } = classifyError(error);
        printErr(message, { code });
    }
};

export function registerUpdateCommand(device) {
    const update = device.command('update').description('Check for or apply agent updates');

    update
        .command('check <deviceId>')
        .description('Check if an agent update is available')
        .option('-j, --json', 'Output as JSON')
        .option('--channel <name>', 'Update channel (default: latest)')
        .action((deviceId, opts, cmd) => runUpdate('check', deviceId, opts, cmd));

    update
        .command('apply <deviceId>')
        .description('Apply an agent update')
        .option('-j, --json', 'Output as JSON')
        .option('--channel <name>', 'Update channel (default: latest)')
        .action((deviceId, opts, cmd) => runUpdate('apply', deviceId, opts, cmd));
}
