import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import api from '../lib/api.js';
import {
    addLogSource,
    getProductLogs,
    removeLogSource,
    setDefaultLogSource,
    LOGS_PROPERTY,
} from '../lib/product/logs.js';

/**
 * In-memory backend for the product property endpoints. Each test starts
 * from a fresh instance via `setupBackend()`. Methods on the axios
 * singleton (`api.get`, `api.put`, `api.delete`) are replaced with thin
 * adapters that translate the request URL into a property lookup against
 * `state` — the same shape the real server returns, so the helpers never
 * notice they're talking to a stub.
 */
function setupBackend(initial = {}) {
    const state = new Map(Object.entries(initial));
    const url = (product) => `/v1/users/admin/products/${product}/properties/${LOGS_PROPERTY}`;

    api.get = async (path) => {
        for (const [product, value] of state.entries()) {
            if (path === url(product)) {
                if (value === undefined) {
                    const err = new Error('Property not found');
                    err.response = { status: 404 };
                    throw err;
                }
                return { data: { value } };
            }
        }
        const err = new Error('Property not found');
        err.response = { status: 404 };
        throw err;
    };
    api.put = async (path, body) => {
        for (const product of [...state.keys(), ...Object.keys(initial)]) {
            if (path === url(product)) {
                state.set(product, body.value);
                return { data: { product, property: LOGS_PROPERTY, value: body.value } };
            }
        }
        // For products not pre-seeded, accept the write anyway.
        const match = path.match(/products\/([^/]+)\/properties\/logs$/);
        if (match) {
            state.set(match[1], body.value);
            return { data: { product: match[1], property: LOGS_PROPERTY, value: body.value } };
        }
        throw new Error(`Unexpected PUT ${path}`);
    };
    api.delete = async (path) => {
        for (const product of state.keys()) {
            if (path === url(product)) {
                state.delete(product);
                return { data: { ok: true } };
            }
        }
        const err = new Error('Property not found');
        err.response = { status: 404 };
        throw err;
    };
    return state;
}

const USER = 'admin';

describe('addLogSource', () => {
    let state;
    beforeEach(() => {
        state = setupBackend();
    });

    it('creates the property when missing and adds the source as default when asked', async () => {
        const { config, action } = await addLogSource(
            'p',
            { name: 'system', command: 'journalctl -f', makeDefault: true },
            USER,
        );
        assert.equal(action, 'added');
        assert.deepEqual(config, {
            sources: [{ name: 'system', command: 'journalctl -f' }],
            default: 'system',
        });
        assert.deepEqual(state.get('p'), config);
    });

    it('preserves the previous default when adding a new non-default source', async () => {
        await addLogSource(
            'p',
            { name: 'system', command: 'journalctl -f', makeDefault: true },
            USER,
        );
        const { config, action } = await addLogSource(
            'p',
            { name: 'thinger', command: 'docker logs -f thinger' },
            USER,
        );
        assert.equal(action, 'added');
        assert.equal(config.default, 'system');
        assert.equal(config.sources.length, 2);
    });

    it('updates an existing source in place', async () => {
        await addLogSource(
            'p',
            { name: 'system', command: 'journalctl -f' },
            USER,
        );
        const { config, action } = await addLogSource(
            'p',
            { name: 'system', command: 'journalctl -u kernel -f' },
            USER,
        );
        assert.equal(action, 'updated');
        assert.equal(config.sources.length, 1);
        assert.equal(config.sources[0].command, 'journalctl -u kernel -f');
    });

    it('promotes a source to default when makeDefault is set on update', async () => {
        await addLogSource('p', { name: 'system', command: 'journalctl -f', makeDefault: true }, USER);
        await addLogSource('p', { name: 'thinger', command: 'docker logs -f thinger' }, USER);
        const { config } = await addLogSource(
            'p',
            { name: 'thinger', command: 'docker logs -f thinger', makeDefault: true },
            USER,
        );
        assert.equal(config.default, 'thinger');
    });
});

describe('removeLogSource', () => {
    let state;
    beforeEach(() => {
        state = setupBackend();
    });

    it('returns removed=false when the property is missing', async () => {
        const { removed, config } = await removeLogSource('p', 'system', USER);
        assert.equal(removed, false);
        assert.equal(config, null);
    });

    it('drops a source and preserves the default when it does not match', async () => {
        await addLogSource('p', { name: 'system', command: 'journalctl -f', makeDefault: true }, USER);
        await addLogSource('p', { name: 'thinger', command: 'docker logs -f thinger' }, USER);
        const { removed, config } = await removeLogSource('p', 'thinger', USER);
        assert.equal(removed, true);
        assert.equal(config.sources.length, 1);
        assert.equal(config.default, 'system');
    });

    it('drops the default when removing the matching source', async () => {
        await addLogSource('p', { name: 'system', command: 'journalctl -f', makeDefault: true }, USER);
        await addLogSource('p', { name: 'thinger', command: 'docker logs -f thinger' }, USER);
        const { removed, config } = await removeLogSource('p', 'system', USER);
        assert.equal(removed, true);
        assert.equal(config.sources.length, 1);
        assert.equal(config.default, undefined);
    });

    it('clears the property entirely when removing the last source', async () => {
        await addLogSource('p', { name: 'system', command: 'journalctl -f', makeDefault: true }, USER);
        const { removed, config } = await removeLogSource('p', 'system', USER);
        assert.equal(removed, true);
        assert.equal(config, null);
        assert.equal(state.has('p'), false);
    });

    it('reports removed=false when the named source is not present', async () => {
        await addLogSource('p', { name: 'system', command: 'journalctl -f' }, USER);
        const { removed, config } = await removeLogSource('p', 'nope', USER);
        assert.equal(removed, false);
        assert.equal(config.sources.length, 1);
    });
});

describe('setDefaultLogSource', () => {
    beforeEach(() => {
        setupBackend();
    });

    it('refuses to set a default when the product has no sources configured', async () => {
        await assert.rejects(
            setDefaultLogSource('p', 'system', USER),
            (err) => err.code === 'input_error' && /no logs sources configured/.test(err.message),
        );
    });

    it('rejects a name that does not match any configured source', async () => {
        await addLogSource('p', { name: 'system', command: 'journalctl -f' }, USER);
        await assert.rejects(
            setDefaultLogSource('p', 'thinger', USER),
            (err) => err.code === 'input_error' && /not configured/.test(err.message),
        );
    });

    it('promotes a configured source to default', async () => {
        await addLogSource('p', { name: 'system', command: 'journalctl -f', makeDefault: true }, USER);
        await addLogSource('p', { name: 'thinger', command: 'docker logs -f thinger' }, USER);
        const cfg = await setDefaultLogSource('p', 'thinger', USER);
        assert.equal(cfg.default, 'thinger');
    });

    it('clears the default when name is null', async () => {
        await addLogSource('p', { name: 'system', command: 'journalctl -f', makeDefault: true }, USER);
        const cfg = await setDefaultLogSource('p', null, USER);
        assert.equal(cfg.default, undefined);
    });
});

describe('getProductLogs', () => {
    beforeEach(() => {
        setupBackend();
    });

    it('returns the synthetic fallback when the property is missing', async () => {
        const cfg = await getProductLogs('p', USER);
        assert.equal(cfg.__fallback, true);
        assert.equal(cfg.sources.length, 1);
        assert.equal(cfg.sources[0].name, 'system');
    });

    it('returns the stored config when the property exists', async () => {
        await addLogSource('p', { name: 'system', command: 'journalctl -f', makeDefault: true }, USER);
        const cfg = await getProductLogs('p', USER);
        assert.equal(cfg.__fallback, undefined);
        assert.equal(cfg.default, 'system');
    });
});
