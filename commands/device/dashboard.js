// @ts-check
import { ensureConfigured } from './_shared.js';

export function registerDashboardCommand(device) {
    device
        .command('dashboard')
        .helpGroup('Discovery:')
        .description('Interactive TUI dashboard for devices (experimental)')
        .action(async () => {
            ensureConfigured();
            if (!process.stdout.isTTY) {
                console.error('dashboard requires an interactive terminal (TTY).');
                process.exit(1);
            }
            const { run } = await import('../../dist/dashboard.js');
            await run();
        });
}
