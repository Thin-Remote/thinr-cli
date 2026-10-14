import './setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localFileToRead, localFileToWrite } from '../lib/local-files.js';

// Push and pull from the MCP server only reach files of one folder: a
// prompt injected through a device cannot send ~/.ssh away or overwrite a
// shell profile.
describe('local files of the MCP server', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thinr-local-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'thinr-outside-'));
    fs.writeFileSync(path.join(root, 'in.txt'), 'in');
    fs.writeFileSync(path.join(outside, 'secret'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'link'));

    it('reads only inside the folder, links resolved', () => {
        assert.equal(localFileToRead('in.txt', root), fs.realpathSync(path.join(root, 'in.txt')));
        assert.throws(() => localFileToRead(path.join(outside, 'secret'), root), /outside/);
        assert.throws(() => localFileToRead('../x', root), /outside|No local file/);
        assert.throws(() => localFileToRead('link', root), /outside/);
    });

    it('writes only inside the folder, replacing only when asked and never through a link', () => {
        const fresh = localFileToWrite('new.txt', root);
        assert.equal(fresh, path.join(fs.realpathSync(root), 'new.txt'));
        assert.throws(() => localFileToWrite('in.txt', root), /exists: pass overwrite/);
        assert.ok(localFileToWrite('in.txt', root, { overwrite: true }));
        assert.throws(() => localFileToWrite('link', root, { overwrite: true }), /is a link/);
        assert.throws(() => localFileToWrite(path.join(outside, 'x'), root), /outside/);
        assert.throws(() => localFileToWrite('../escape.txt', root), /outside/);
    });
});
