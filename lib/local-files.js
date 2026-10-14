// @ts-check
import { existsSync, lstatSync, realpathSync } from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import { inputError } from '@thinger-io/cli-core/errors';

/**
 * Files of the machine running the MCP server, as a model names them for a
 * push or a pull: kept inside one folder, so a prompt injected through a
 * device (a log line, a file) cannot have the model send ~/.ssh away or
 * overwrite a shell profile. The folder is THINR_MCP_LOCAL_DIR, or the
 * folder the server was started in.
 */
export function mcpLocalRoot() {
    return resolve(process.env.THINR_MCP_LOCAL_DIR || process.cwd());
}

const inside = (root, path) => {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
};

const outside = (path, root) =>
    inputError(
        `${path} is outside ${root}, the only folder of this machine the MCP server reads and writes (THINR_MCP_LOCAL_DIR changes it)`,
    );

/** A file to read (push): it must exist inside the root, links resolved. */
export function localFileToRead(path, root = mcpLocalRoot()) {
    const realRoot = realpathSync(root);
    const wanted = resolve(realRoot, path);
    if (!existsSync(wanted)) throw inputError(`No local file ${wanted}`);
    const real = realpathSync(wanted);
    if (!inside(realRoot, real)) throw outside(real, realRoot);
    return real;
}

/**
 * A file to write (pull): its folder inside the root, links resolved; an
 * existing file only replaced when asked, and never through a link.
 */
export function localFileToWrite(path, root = mcpLocalRoot(), { overwrite = false } = {}) {
    const realRoot = realpathSync(root);
    const wanted = resolve(realRoot, path);
    const dir = dirname(wanted);
    if (!existsSync(dir)) throw inputError(`No local folder ${dir}`);
    const target = resolve(realpathSync(dir), wanted.slice(dir.length + 1));
    if (!inside(realRoot, target)) throw outside(target, realRoot);
    if (existsSync(target)) {
        if (lstatSync(target).isSymbolicLink())
            throw inputError(`${target} is a link: not written`);
        if (!overwrite) throw inputError(`${target} exists: pass overwrite to replace it`);
    }
    return target;
}
