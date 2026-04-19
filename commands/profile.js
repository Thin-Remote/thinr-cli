import chalk from 'chalk';
import { input } from '@inquirer/prompts';
import {
    listProfiles,
    getActiveProfile,
    getProfile,
    setActiveProfile,
    setDefaultProfile,
    deleteProfile,
} from '../lib/config.js';
import { authenticate } from '../lib/auth.js';
import { setJsonMode, isJsonMode, printOk, printErr } from '../lib/output.js';

function applyJsonFlag(opts) {
    if (opts.json) setJsonMode(true);
}

export function profileCommand(program) {
    const profile = program.command('profile').description('Manage configuration profiles');

    profile
        .command('list')
        .description('List configured profiles')
        .option('-j, --json', 'Output as JSON')
        .action((opts) => {
            applyJsonFlag(opts);
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
        .action((opts) => {
            applyJsonFlag(opts);
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
        .action((name, opts) => {
            applyJsonFlag(opts);
            try {
                setDefaultProfile(name);
            } catch (error) {
                printErr(error.message, { code: 'not_found' });
                return;
            }
            if (isJsonMode()) {
                printOk({ active: name });
                return;
            }
            console.log(chalk.green(`Default profile set to ${name}`));
        });

    profile
        .command('add [name]')
        .description('Add a new profile via interactive authentication')
        .option('--no-activate', 'Do not set the new profile as default')
        .option('-j, --json', 'Output as JSON')
        .action(async (nameArg, opts) => {
            applyJsonFlag(opts);
            let name = nameArg;
            if (!name) {
                try {
                    name = await input({
                        message: 'Profile name:',
                        validate: (v) => {
                            const trimmed = (v || '').trim();
                            if (!trimmed) return 'Profile name is required';
                            if (/\s/.test(trimmed)) return 'Profile name cannot contain whitespace';
                            return true;
                        },
                    });
                } catch (error) {
                    printErr(error.message || 'Prompt cancelled');
                    return;
                }
            }
            name = name.trim();
            if (getProfile(name)) {
                printErr(`Profile already exists: ${name}`, { code: 'already_exists' });
                return;
            }
            setActiveProfile(name);
            try {
                await authenticate();
                const saved = getProfile(name);
                if (!saved || !saved.token || !saved.username) {
                    throw new Error('Authentication did not complete; profile discarded.');
                }
            } catch (error) {
                setActiveProfile(null);
                try {
                    deleteProfile(name);
                } catch {
                    // Best-effort cleanup — ignore secondary failures
                }
                printErr(error.message || 'Authentication failed');
                return;
            }
            const activate = opts.activate !== false;
            if (activate) setDefaultProfile(name);
            setActiveProfile(null);
            if (isJsonMode()) {
                printOk({ added: name, activated: activate, active: getActiveProfile() });
                return;
            }
            const suffix = activate ? ' and set as default' : '';
            console.log(chalk.green(`Profile ${name} added${suffix}`));
        });

    profile
        .command('delete <name>')
        .description('Remove a profile')
        .option('-j, --json', 'Output as JSON')
        .action((name, opts) => {
            applyJsonFlag(opts);
            const ok = deleteProfile(name);
            if (!ok) {
                printErr(`Profile not found: ${name}`, { code: 'not_found' });
                return;
            }
            if (isJsonMode()) {
                printOk({ removed: name });
                return;
            }
            console.log(chalk.green(`Removed profile ${name}`));
        });
}
