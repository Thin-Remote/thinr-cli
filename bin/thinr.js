#!/usr/bin/env node

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { defineIdentity } from '@thinger-io/cli-core/identity';
import { runCli } from '@thinger-io/cli-core/cli';
import { thinrIdentity } from '../lib/identity.js';
import { cliOptions } from '../lib/cli.js';

// Single source of truth for the version: package.json. Avoids the drift
// between `package.json#version` and a hardcoded string in this file.
const pkg = JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
);

defineIdentity(thinrIdentity);

await runCli({ version: pkg.version, ...cliOptions });
