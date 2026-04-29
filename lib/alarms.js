import api from './api.js';
import { apiError } from './errors.js';
import { requireConfig } from './config.js';

function resolveUser(user) {
    return user || requireConfig().username;
}

// Backend enums (see backend/src/thinger/features/alarms/alarm_rule.hpp).
// Exported so the dashboard can render labels/colors without re-deriving
// them from string heuristics.
export const ALARM_STATE = {
    NONE: 0,
    ACTIVATED: 1,
    ACKNOWLEDGED: 2,
    LATCHED: 3,
    SHELVED: 4,
    CLEARED: 5,
};

export const ALARM_SEVERITY = {
    NONE: 0,
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
    CRITICAL: 4,
};

export const ALARM_STATE_LABEL = {
    0: 'none',
    1: 'active',
    2: 'ack',
    3: 'latched',
    4: 'shelved',
    5: 'cleared',
};

export const ALARM_SEVERITY_LABEL = {
    0: 'none',
    1: 'low',
    2: 'med',
    3: 'high',
    4: 'crit',
};

// Repeats a query param as the server expects (`?state=1&state=2`).
function appendMulti(params, key, values) {
    if (values == null) return;
    const arr = Array.isArray(values) ? values : [values];
    for (const v of arr) params.append(key, String(v));
}

/**
 * Query alarm instances from /v1/users/{user}/alarms/instances.
 *
 * `state` and `severity` are repeated query params — pass numbers or
 * arrays of numbers (matching the ALARM_STATE / ALARM_SEVERITY enums).
 *
 * @param {{
 *   user?: string | null,
 *   count?: number,
 *   index?: number,
 *   name?: string,
 *   state?: number | number[],
 *   severity?: number | number[],
 *   sort?: string,
 *   order?: string,
 * }} [opts]
 */
export async function getAlarmInstances({
    user = null,
    count = 100,
    index = 0,
    name,
    state,
    severity,
    sort,
    order,
} = {}) {
    const apiUser = resolveUser(user);
    const params = new URLSearchParams();
    params.set('count', String(count));
    params.set('index', String(index));
    if (name) params.set('name', name);
    if (sort) params.set('sort', sort);
    if (order) params.set('order', order);
    appendMulti(params, 'state', state);
    appendMulti(params, 'severity', severity);
    try {
        const res = await api.get(
            `/v1/users/${apiUser}/alarms/instances?${params.toString()}`,
        );
        return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
        throw apiError(e);
    }
}

// Counter per state, e.g. { activated: 3, acknowledged: 1, ... }. The
// server seeds zeros for every known state so consumers can render a
// stable layout without null-checks.
export async function getAlarmInstanceStats({ user = null } = {}) {
    const apiUser = resolveUser(user);
    try {
        const res = await api.get(`/v1/users/${apiUser}/alarms/instances/stats`);
        return res.data || {};
    } catch (e) {
        throw apiError(e);
    }
}
