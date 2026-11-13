import './setup.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    addImpersonatingProfile,
    deleteConfig,
    setActiveProfile,
    withActiveProfile,
    writeConfig,
} from '@thinger-io/cli-core/config';
import { agentInstallCommand } from '../lib/mcp/agent-install.js';

describe('agent install command', () => {
    beforeEach(() => {
        deleteConfig();
        setActiveProfile('admin');
        writeConfig({ server: 'acme.example.com', username: 'alvaro', token: 'T-admin' });
        setActiveProfile(null);
        addImpersonatingProfile('monitoring', {
            credentialsFrom: 'admin',
            impersonate: 'monitoring',
        });
    });

    it('never carries the admin session of a profile acting as another account', async () => {
        await assert.rejects(
            withActiveProfile('monitoring', () => agentInstallCommand({})),
            (e) => {
                assert.match(
                    e.message,
                    /Profile monitoring acts as monitoring with the session of profile admin/,
                );
                assert.doesNotMatch(e.message, /T-admin/);
                return true;
            },
        );
    });

    it('carries the session of a profile signed in as its account', async () => {
        const result = await withActiveProfile('admin', () => agentInstallCommand({}));
        assert.match(JSON.stringify(result), /--token 'T-admin'/);
    });
});
