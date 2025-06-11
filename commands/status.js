import { getDeviceStatus, formatDeviceStatus } from '../lib/status.js';
import chalk from 'chalk';
import ora from 'ora';
import { configExists } from '../lib/config.js';

/**
 * Register the status command
 * @param {Command} program - Commander program instance
 */
export function statusCommand(program) {
    program
        .command('status')
        .description('Check the status of a remote device')
        .argument('<deviceId>', 'Device ID to check')
        .option('-j, --json', 'Output as JSON', false)
        .action(async (deviceId, options) => {
            // Check if configured
            if (!configExists()) {
                console.error(chalk.red('Error: Not configured. Run thingr without parameters to set up.'));
                process.exit(1);
            }

            const spinner = ora(`Checking status of ${deviceId}...`).start();

            try {
                // Get device status
                const status = await getDeviceStatus(deviceId);

                spinner.succeed(`Device ${deviceId} found`);

                // Output as JSON if requested
                if (options.json) {
                    console.log(JSON.stringify(status, null, 2));
                } else {
                    // Format and display status
                    console.log(formatDeviceStatus(deviceId, status));
                }
            } catch (error) {
                spinner.fail(`Status check failed`);
                console.error(chalk.red(`Error: ${error.message}`));
                process.exit(1);
            }
        });
}