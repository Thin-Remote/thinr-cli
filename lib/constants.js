// @ts-check

/**
 * Central home for the numeric knobs the CLI scatters otherwise.
 * Keep every "magic number" that has meaning beyond its immediate call
 * site here so we can tune them in one place (and grep for them when
 * debugging a stuck transfer or a missed OAuth poll).
 */

/** Timeouts. All values in ms unless the constant name ends in `_SECONDS`. */
export const TIMEOUTS = {
    /** Default axios request timeout for control-plane HTTP calls. */
    API_DEFAULT_MS: 10_000,

    /** POSTs to device resources (cmd, update, etc.) — mid-weight calls. */
    DEVICE_RESOURCE_CALL_MS: 30_000,

    /** GETs that read a device resource value. */
    DEVICE_RESOURCE_GET_MS: 15_000,

    /** Playbook `update: apply` — agent updates can take minutes. */
    DEVICE_UPDATE_APPLY_MS: 300_000,

    /**
     * Grace period added client-side on top of the server/agent's exec
     * timeout so a hung agent doesn't keep the WebSocket open forever.
     * Not proportional to the declared timeout — a 5-min command
     * shouldn't wait 5 extra minutes just in case.
     */
    EXEC_SAFETY_GRACE_MS: 2_000,

    /**
     * Extra headroom on the HTTP call that wraps the legacy `api.exec`
     * resource call, so the agent's own timeout has a chance to fire
     * and return a proper exit code before axios aborts.
     */
    EXEC_EXTRA_GRACE_MS: 5_000,

    /** Hard ceiling for the OAuth device-code flow — 10 minutes. */
    OAUTH_DEVICE_CODE_MS: 10 * 60 * 1000,

    /**
     * Default command timeout (in *seconds*) for user-facing exec
     * flows: CLI `device exec`, `product exec`, playbook `exec`, MCP
     * `thinr_exec`. Callers override when they know better.
     */
    DEFAULT_EXEC_SECONDS: 30,

    /** Chmod after a script install: tiny op, short seconds-level cap. */
    SCRIPT_CHMOD_SECONDS: 10,
};

/** Byte units, so callers don't have to eyeball `1073741824`. */
export const BYTES = {
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,

    /**
     * Chunk size used when wrapping in-memory buffers as Readable
     * streams for file uploads, so `onUploadProgress` fires per chunk
     * instead of once at 0% and once at 100%.
     */
    STREAM_CHUNK: 64 * 1024,
};

/** Random-port range used when creating TCP/HTTP proxies. */
export const PROXY_PORTS = {
    MIN: 50_000,
    MAX: 51_000,
};

/** OAuth device-flow client identity registered for this CLI. */
export const OAUTH = {
    CLIENT_ID: '3b40164d28730e416cbd',
};
