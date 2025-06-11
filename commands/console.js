import { connectToDeviceConsole } from '../lib/console.js';
import chalk from 'chalk';
import { configExists } from '../lib/config.js';

/**
 * Register the console command
 * @param {Command} program -  program instance
 */
export function consoleCommand(program) {
    program
        .command('console')
        .description('Open a terminal console to a remote device')
        .argument('<deviceId>', 'Device ID to connect to')
        .action(async (deviceId) => {
            // Check if configured
            if (!configExists()) {
                console.error(chalk.red('Error: Not configured. Run thingr without parameters to set up.'));
                process.exit(1);
            }

            try {
                // Connect to device console
                await connectToDeviceConsole(deviceId);
            } catch (error) {
                console.error(chalk.red(`Error: ${error.message}`));
                process.exit(1);
            }
        });
}