import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    PLAYBOOK_NAME_RE,
    deleteProductPlaybook,
    playbookStoragePath,
    uploadProductPlaybook,
} from '../lib/product.js';

describe('product playbook name validation', () => {
    it('accepts identifier-style names', () => {
        for (const name of ['deploy', 'Deploy-v2', 'rollout_9', 'a', '_-']) {
            assert.ok(PLAYBOOK_NAME_RE.test(name), `expected "${name}" to be accepted`);
        }
    });

    it('rejects names with invalid characters', () => {
        for (const name of ['has space', 'dots.allowed', 'slash/ok', 'á', '', 'tab\t']) {
            assert.equal(
                PLAYBOOK_NAME_RE.test(name),
                false,
                `expected "${name}" to be rejected`,
            );
        }
    });
});

describe('playbookStoragePath', () => {
    it('puts YAML under the reserved playbooks/ folder', () => {
        assert.equal(playbookStoragePath('deploy'), 'playbooks/deploy.yaml');
    });
});

describe('uploadProductPlaybook — pre-network validation', () => {
    const minimalYaml = `target:\n  product: demo\nsteps:\n  - action: sleep\n    seconds: 1\n`;

    it('rejects invalid playbook names before touching the network', async () => {
        await assert.rejects(
            uploadProductPlaybook({
                product: 'p',
                name: 'bad name',
                content: minimalYaml,
            }),
            (err) => err.code === 'input_error' && /Invalid playbook name/.test(err.message),
        );
    });

    it('requires content as a string', async () => {
        await assert.rejects(
            uploadProductPlaybook({ product: 'p', name: 'ok', content: 123 }),
            (err) => err.code === 'input_error' && /content is required/.test(err.message),
        );
    });

    it('rejects invalid YAML when validation is enabled', async () => {
        await assert.rejects(
            uploadProductPlaybook({
                product: 'p',
                name: 'ok',
                content: 'target: product: [broken',
            }),
            /Invalid YAML/,
        );
    });

    it('rejects a playbook that fails schema validation', async () => {
        await assert.rejects(
            uploadProductPlaybook({
                product: 'p',
                name: 'ok',
                content: 'target: {}\nsteps:\n  - action: fake\n',
            }),
            /Invalid playbook/,
        );
    });
});

describe('deleteProductPlaybook — pre-network validation', () => {
    it('rejects invalid playbook names before touching the network', async () => {
        await assert.rejects(
            deleteProductPlaybook({ product: 'p', name: 'bad name' }),
            (err) => err.code === 'input_error' && /Invalid playbook name/.test(err.message),
        );
    });

    it('requires the product id', async () => {
        await assert.rejects(
            deleteProductPlaybook({ name: 'ok' }),
            (err) => err.code === 'input_error' && /product is required/.test(err.message),
        );
    });
});
