import ora from 'ora';
import { deleteConfig, configExists } from '../lib/config.js';
import { warning, error, hint } from '../lib/format.js';

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
                console.log(warning('No configuration found. Already logged out.'));
                return;
            }

            const spinner = ora('Removing configuration...').start();

            try {
                // Delete local configuration
                spinner.text = 'Removing local configuration...';
                const ok = deleteConfig();

                if (ok) {
                    spinner.succeed('Logged out successfully. Configuration removed.');
                } else {
                    spinner.fail('Failed to remove configuration.');
                    console.error(
                        error(
                            'Error: Unable to delete configuration file. You may need to remove it manually.',
                        ),
                    );
                    console.error(
                        hint('Configuration is stored in ~/.config/thinr-cli/config.json'),
                    );
                }
            } catch (err) {
                spinner.fail('Failed to remove configuration.');
                console.error(error(`Error: ${err.message}`));
                console.error(hint('Configuration is stored in ~/.config/thinr-cli/config.json'));
            }
        });
}
