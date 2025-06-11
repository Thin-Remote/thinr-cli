import chalk from 'chalk';
import ora from 'ora';
import { deleteConfig, configExists } from '../lib/config.js';
import { deleteToken } from '../lib/auth.js';

/**
 * Register the logout command
 * @param {Command} program - Commander program instance
 */
export function logoutCommand(program) {
    program
        .command('logout')
        .description('Remove stored credentials and configuration')
        .action(async () => {
            // Check if configured
            if (!configExists()) {
                console.log(chalk.yellow('No configuration found. Already logged out.'));
                return;
            }

            const spinner = ora('Removing configuration...').start();

            try {
                // Delete token from server first
                spinner.text = 'Deleting token from server...';
                await deleteToken();

                // Delete local configuration
                spinner.text = 'Removing local configuration...';
                const success = deleteConfig();

                if (success) {
                    spinner.succeed('Logged out successfully. Configuration removed.');
                } else {
                    spinner.fail('Failed to remove configuration.');
                    console.error(chalk.red('Error: Unable to delete configuration file. You may need to remove it manually.'));
                    console.error(chalk.gray('Configuration is stored in ~/.thingr/config.json'));
                }
            } catch (error) {
                spinner.fail('Failed to remove configuration.');
                console.error(chalk.red(`Error: ${error.message}`));
                console.error(chalk.gray('Configuration is stored in ~/.thingr/config.json'));
            }
        });
}