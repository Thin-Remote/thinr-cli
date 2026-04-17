// @ts-check
import { loadPlaybookFile } from '../../lib/playbook/loader.js';
import { isJsonMode, printOk, printErr, classifyError } from '../../lib/output.js';
import { success, label, hint } from '../../lib/format.js';
import { applyJsonFlag } from './_shared.js';

export function registerValidateCommand(playbook) {
    playbook
        .command('validate <file>')
        .helpGroup('Playbook:')
        .description('Parse and validate a playbook without running it')
        .option('-j, --json', 'Output as JSON')
        .action((file, opts) => {
            applyJsonFlag(opts);
            try {
                const pb = loadPlaybookFile(file);
                if (isJsonMode()) {
                    printOk({
                        valid: true,
                        name: pb.name,
                        target: pb.target,
                        steps: pb.steps.map((s) => ({
                            name: s.name,
                            action: s.action,
                        })),
                    });
                    return;
                }
                console.log(success('✔ Playbook is valid'));
                if (pb.name) console.log(label(pb.name));
                if (pb.description) console.log(hint(pb.description));
                console.log(hint(`${pb.steps.length} step(s)`));
            } catch (error) {
                const { message, code } = classifyError(error);
                printErr(message, { code: code === 'error' ? 'input_error' : code });
            }
        });
}
