// @ts-check
import { ensureConfigured } from './device/_shared.js';

export function dashboardCommand(program) {
    program
        .command('dashboard')
        .helpGroup('Discovery:')
        .description('Interactive TUI dashboard for the fleet (experimental)')
        .action(async () => {
            ensureConfigured();
            if (!process.stdout.isTTY) {
                console.error('dashboard requires an interactive terminal (TTY).');
                process.exit(1);
            }
            const { run } = await import('../dist/dashboard.js');
            await run();
        });
}
