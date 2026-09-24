// @ts-check
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import api from '../lib/api.js';
import {
    callDeviceResource,
    getDeviceResourceApi,
    getDeviceResources,
    listDeviceResourcesWithSchemas,
    readDeviceResource,
} from '../lib/resource.js';

const DEVICE = 'edge-gw-17';
const OWNER = { user: 'acme' };

let calls;

function setupBackend() {
    calls = [];
    api.get = async (path) => {
        calls.push({ method: 'GET', path });
        return { data: { monitoring: { fn: 3 }, '$scripts/info': { fn: 3 } } };
    };
    api.post = async (path, body) => {
        calls.push({ method: 'POST', path, body });
        return { data: { ok: true } };
    };
}

// Every helper here must address the account that owns the device, not the
// one the active profile belongs to, or an admin acting on behalf of another
// account reaches the wrong URL and the API answers "not found".
describe('resource helpers address the requested account', () => {
    beforeEach(setupBackend);

    it('getDeviceResources', async () => {
        await getDeviceResources(DEVICE, OWNER);
        assert.equal(calls[0].path, `/v3/users/acme/devices/${DEVICE}/resources/api`);
    });

    it('readDeviceResource', async () => {
        await readDeviceResource(DEVICE, 'monitoring', OWNER);
        assert.equal(calls[0].path, `/v3/users/acme/devices/${DEVICE}/resources/monitoring`);
    });

    it('getDeviceResourceApi', async () => {
        await getDeviceResourceApi(DEVICE, 'monitoring', OWNER);
        assert.equal(calls[0].path, `/v3/users/acme/devices/${DEVICE}/resources/monitoring/api`);
    });

    it('callDeviceResource reads with GET when there are no inputs', async () => {
        await callDeviceResource(DEVICE, 'monitoring', null, OWNER);
        assert.equal(calls[0].method, 'GET');
        assert.equal(calls[0].path, `/v3/users/acme/devices/${DEVICE}/resources/monitoring`);
    });

    it('callDeviceResource posts the inputs when there are any', async () => {
        await callDeviceResource(DEVICE, '$scripts/reload', { force: true }, OWNER);
        assert.equal(calls[0].method, 'POST');
        assert.equal(calls[0].path, `/v3/users/acme/devices/${DEVICE}/resources/$scripts/reload`);
        assert.deepEqual(calls[0].body, { force: true });
    });

    it('listDeviceResourcesWithSchemas carries the account into every schema lookup', async () => {
        await listDeviceResourcesWithSchemas(DEVICE, OWNER);
        assert.ok(calls.length > 1, 'expected a listing plus per-resource schema lookups');
        for (const call of calls) {
            assert.ok(
                call.path.startsWith('/v3/users/acme/'),
                `${call.path} should be addressed to acme`,
            );
        }
    });
});
