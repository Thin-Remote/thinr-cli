import {
    listProfiles,
    getActiveProfile,
    getProfile,
    setDefaultProfile,
    deleteProfile,
} from '../lib/config.js';
import { setJsonMode, isJsonMode, printOk, printErr } from '../lib/output.js';
import { hint, success, label } from '../lib/format.js';

function applyJsonFlag(opts) {
    if (opts.json) setJsonMode(true);
}

export function profileCommand(program) {
    const profile = program
        .command('profile')
        .helpGroup('Configuration:')
        .description('Manage configuration profiles');

    profile
        .command('list')
        .helpGroup('Profile:')
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
                console.log(hint('No profiles configured. Run thinr to set one up.'));
                return;
            }
            for (const name of names) {
                const data = getProfile(name) || {};
                const marker = name === active ? success('* ') : '  ';
                const detail = hint(`${data.username || ''}@${data.server || name}`);
                console.log(`${marker}${label(name)}  ${detail}`);
            }
        });

    profile
        .command('current')
        .helpGroup('Profile:')
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
                console.log(hint('No active profile.'));
                return;
            }
            console.log(name);
        });

    profile
        .command('use <name>')
        .helpGroup('Profile:')
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
            console.log(success(`Default profile set to ${name}`));
        });

    profile
        .command('delete <name>')
        .helpGroup('Profile:')
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
            console.log(success(`Removed profile ${name}`));
        });
}
