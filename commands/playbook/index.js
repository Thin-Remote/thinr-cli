// @ts-check
import { registerRunCommand } from './run.js';
import { registerValidateCommand } from './validate.js';

/**
 * `thinr playbook <subcommand>` — declarative, repeatable sequences of
 * agent actions over a fleet. See `lib/playbook/schema.js` for the
 * accepted format.
 */
export function playbookCommand(program) {
    const playbook = program
        .command('playbook')
        .helpGroup('Operations:')
        .description('Run declarative YAML playbooks against the fleet');

    registerRunCommand(playbook);
    registerValidateCommand(playbook);
}
