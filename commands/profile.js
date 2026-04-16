import chalk from 'chalk';
import {
    listProfiles,
    getActiveProfile,
    getProfile,
    setDefaultProfile,
    deleteProfile,
} from '../lib/config.js';
import { isJsonMode, printOk, printErr } from '../lib/output.js';

export function profileCommand(program) {
    const profile = program.command('profile').description('Manage configuration profiles');

    profile
        .command('list')
        .description('List configured profiles')
        .option('-j, --json', 'Output as JSON')
        .action(() => {
            const names = listProfiles();
            const active = getActiveProfile();
            if (isJsonMode()) {
                const entries = names.map((name) => {
                    const data = getProfile(name) || {};
                    return {
                        name,
                        active: name === active,
                        username: data.username || null,
                        server: data.server || null,
                    };
                });
                printOk({ active, profiles: entries });
                return;
            }
            if (!names.length) {
                console.log(chalk.gray('No profiles configured. Run thinr to set one up.'));
                return;
            }
            for (const name of names) {
                const data = getProfile(name) || {};
                const marker = name === active ? chalk.green('* ') : '  ';
                const detail = chalk.gray(`${data.username || ''}@${data.server || name}`);
                console.log(`${marker}${chalk.bold(name)}  ${detail}`);
            }
        });

    profile
        .command('current')
        .description('Print the active profile')
        .option('-j, --json', 'Output as JSON')
        .action(() => {
            const name = getActiveProfile();
            if (isJsonMode()) {
                printOk({ active: name });
                return;
            }
            if (!name) {
                console.log(chalk.gray('No active profile.'));
                return;
            }
            console.log(name);
        });

    profile
        .command('use <name>')
        .description('Set the default profile')
        .option('-j, --json', 'Output as JSON')
        .action((name) => {
            try {
                setDefaultProfile(name);
                if (isJsonMode()) {
                    printOk({ active: name });
                    return;
                }
                console.log(chalk.green(`Default profile set to ${name}`));
            } catch (error) {
                printErr(error.message, { code: 'not_found' });
            }
        });

    profile
        .command('delete <name>')
        .description('Remove a profile')
        .option('-j, --json', 'Output as JSON')
        .action((name) => {
            const ok = deleteProfile(name);
            if (!ok) {
                printErr(`Profile not found: ${name}`, { code: 'not_found' });
            }
            if (isJsonMode()) {
                printOk({ removed: name });
                return;
            }
            console.log(chalk.green(`Removed profile ${name}`));
        });
}
