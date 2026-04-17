#!/usr/bin/env node
import { build, context } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outfile = path.resolve(root, 'dist/dashboard.js');
const outDir = path.dirname(outfile);
const libDir = path.resolve(root, 'lib') + path.sep;

// Keep lib/* out of the bundle so the dashboard shares the same
// singleton modules (active profile, base URL, auth, …) with the rest
// of the CLI. Rewrite each import to a path relative to the output
// file; source files at different depths can otherwise end up with
// inconsistent `../..` prefixes.
const libExternalPlugin = {
    name: 'lib-external',
    setup(build) {
        build.onResolve({ filter: /lib\/.+\.js$/ }, (args) => {
            if (!args.importer) return null;
            const importer = path.isAbsolute(args.importer)
                ? args.importer
                : path.resolve(root, args.importer);
            const abs = path.resolve(path.dirname(importer), args.path);
            if (!abs.startsWith(libDir)) return null;
            const rel = path.relative(outDir, abs).split(path.sep).join('/');
            return {
                path: rel.startsWith('.') ? rel : './' + rel,
                external: true,
            };
        });
    },
};

const options = {
    entryPoints: [path.resolve(root, 'src/dashboard/index.jsx')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    jsx: 'automatic',
    packages: 'external',
    plugins: [libExternalPlugin],
    sourcemap: 'inline',
    logLevel: 'info',
};

const watch = process.argv.includes('--watch');
if (watch) {
    const ctx = await context(options);
    await ctx.watch();
} else {
    await build(options);
}
