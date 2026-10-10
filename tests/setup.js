// Shared test setup: imported first by every test file.
//
// Defines thinr's identity (@thinger-io/cli-core refuses to run without
// one) and points HOME at a throwaway folder, so no test ever reads or
// writes the real profiles under ~/.config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineIdentity } from '@thinger-io/cli-core/identity';
import { thinrIdentity } from '../lib/identity.js';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'thinr-cli-test-'));
delete process.env.THINR_PROFILE;
defineIdentity(thinrIdentity);
