// @ts-check
import { inputError } from '../errors.js';
import {
    getProductProperty,
    setProductProperty,
    deleteProductProperty,
} from '../product.js';

/**
 * Schema, validator and helpers for the per-product `logs` property.
 *
 * A product's `logs` value declares the named log streams the dashboard,
 * CLI and MCP can offer for any device bound to that product. Each
 * source is a `{ name, command }` pair: the agent already knows how to
 * exec-stream an arbitrary shell command, so a "log source" is just a
 * label plus the command the client should send. No agent change, no
 * new IOTMP kind — the command is an opaque string that the client
 * stores and forwards.
 *
 * Fallback: when a product has no `logs` property, consumers should
 * behave as before — surface a single synthetic source named `system`
 * whose command is `FALLBACK_LOGS_COMMAND`, mirroring the journalctl
 * stream the dashboard has used historically.
 *
 * @typedef {{ name: string, command: string }} LogSource
 * @typedef {{ sources: LogSource[], default?: string }} LogsConfig
 */

/** Property id under which the config lives on the product. */
export const LOGS_PROPERTY = 'logs';

/** Source name format: slug-ish, ≤ 32 chars, must have at least one char. */
export const LOG_SOURCE_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Maximum number of sources a single config may declare. */
export const MAX_LOG_SOURCES = 32;

/** Command used by the synthetic fallback when no `logs` config exists. */
export const FALLBACK_LOGS_COMMAND = 'journalctl --no-pager --output=short -f';

/** Fallback source name for products without a configured `logs` property. */
export const FALLBACK_LOGS_SOURCE_NAME = 'system';

const SOURCE_KEYS = new Set(['name', 'command']);
const ROOT_KEYS = new Set(['sources', 'default']);

/**
 * Validate and normalize a `logs` property value.
 *
 * Accepts an unknown value, returns a clean copy stripped of unknown
 * keys. Throws `inputError` on the first problem so callers can rely
 * on the returned shape being safe to persist or hand off to the UI.
 *
 * @param {unknown} value
 * @returns {LogsConfig}
 */
export function validateLogsConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw inputError('logs must be an object with a `sources` array');
    }
    const obj = /** @type {Record<string, unknown>} */ (value);

    for (const key of Object.keys(obj)) {
        if (!ROOT_KEYS.has(key)) {
            throw inputError(`logs: unknown key "${key}" (allowed: sources, default)`);
        }
    }

    const rawSources = obj.sources;
    if (!Array.isArray(rawSources)) {
        throw inputError('logs.sources is required and must be an array');
    }
    if (rawSources.length === 0) {
        throw inputError('logs.sources must contain at least one source');
    }
    if (rawSources.length > MAX_LOG_SOURCES) {
        throw inputError(`logs.sources accepts at most ${MAX_LOG_SOURCES} entries`);
    }

    const sources = [];
    const seen = new Set();
    rawSources.forEach((raw, i) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw inputError(`logs.sources[${i}] must be an object with name and command`);
        }
        const entry = /** @type {Record<string, unknown>} */ (raw);
        for (const key of Object.keys(entry)) {
            if (!SOURCE_KEYS.has(key)) {
                throw inputError(
                    `logs.sources[${i}]: unknown key "${key}" (allowed: name, command)`,
                );
            }
        }
        const { name, command } = entry;
        if (typeof name !== 'string' || !LOG_SOURCE_NAME_RE.test(name)) {
            throw inputError(
                `logs.sources[${i}].name must be a slug (letters, digits, underscore, dash; 1-32 chars)`,
            );
        }
        if (seen.has(name)) {
            throw inputError(`logs.sources[${i}].name "${name}" is duplicated`);
        }
        if (typeof command !== 'string' || command.trim() === '') {
            throw inputError(`logs.sources[${i}].command must be a non-empty string`);
        }
        seen.add(name);
        sources.push({ name, command });
    });

    let def;
    if (obj.default !== undefined && obj.default !== null) {
        if (typeof obj.default !== 'string') {
            throw inputError('logs.default must be a string matching a source name');
        }
        if (!seen.has(obj.default)) {
            throw inputError(
                `logs.default "${obj.default}" does not match any source name`,
            );
        }
        def = obj.default;
    }

    /** @type {LogsConfig} */
    const out = { sources };
    if (def !== undefined) out.default = def;
    return out;
}

/**
 * Resolve the active source from a (validated) config. Returns the
 * entry whose name matches `default`, falling back to the first
 * source. Useful for "what should I show first?" decisions in the UI.
 *
 * @param {LogsConfig} config
 * @returns {LogSource}
 */
export function resolveDefaultLogSource(config) {
    if (config.default) {
        const match = config.sources.find((s) => s.name === config.default);
        if (match) return match;
    }
    return config.sources[0];
}

/**
 * Synthetic config returned by `getProductLogs` when the product has
 * no `logs` property set. Keeps consumers compatible with how the
 * dashboard streamed logs before this feature existed.
 *
 * @returns {LogsConfig}
 */
export function fallbackLogsConfig() {
    return {
        sources: [{ name: FALLBACK_LOGS_SOURCE_NAME, command: FALLBACK_LOGS_COMMAND }],
        default: FALLBACK_LOGS_SOURCE_NAME,
    };
}

/**
 * Read a product's `logs` config, validating the stored value before
 * returning it. When the property is missing, returns the synthetic
 * fallback so callers can render a `system` source unconditionally.
 *
 * The returned object always carries a `__fallback` flag so the UI can
 * tell "operator configured this" from "we made one up". The flag is
 * non-enumerable to keep it out of JSON round-trips.
 *
 * @param {string} productId
 * @param {string} [user]
 * @returns {Promise<LogsConfig & { __fallback?: boolean }>}
 */
export async function getProductLogs(productId, user) {
    let raw;
    try {
        raw = await getProductProperty(productId, LOGS_PROPERTY, user);
    } catch (e) {
        if (/Property not found/.test(e?.message || '')) {
            return markFallback(fallbackLogsConfig());
        }
        throw e;
    }
    if (raw === undefined || raw === null) {
        return markFallback(fallbackLogsConfig());
    }
    return validateLogsConfig(raw);
}

function markFallback(config) {
    Object.defineProperty(config, '__fallback', {
        value: true,
        enumerable: false,
        writable: false,
    });
    return config;
}

/**
 * Validate and persist a product's `logs` config. Returns the
 * normalized value that was written.
 *
 * @param {string} productId
 * @param {unknown} value
 * @param {string} [user]
 * @returns {Promise<LogsConfig>}
 */
export async function setProductLogs(productId, value, user) {
    const normalized = validateLogsConfig(value);
    await setProductProperty(productId, LOGS_PROPERTY, normalized, user);
    return normalized;
}

/**
 * Remove the `logs` property from a product. Returns true when the
 * property existed, false when it was already absent.
 *
 * @param {string} productId
 * @param {string} [user]
 * @returns {Promise<boolean>}
 */
export async function deleteProductLogs(productId, user) {
    return deleteProductProperty(productId, LOGS_PROPERTY, user);
}
