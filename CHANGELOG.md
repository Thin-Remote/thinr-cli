# Changelog

## [1.1.0] - 2026-04-16

Major release: MCP server for AI clients, subcommand-first CLI, JSON
output, multi-profile configuration, product-level fan-outs, and a
consistent error taxonomy across both interfaces.

### Added

- **MCP server** (`thinr mcp`) exposing ~26 typed tools over stdio for AI
  clients (Claude Code, Claude Desktop, and any other MCP host). Covers
  discovery, shell `exec`, filesystem (`read`/`write`/`ls`/`mkdir`/`delete`/
  `move`), typed `resource` calls, properties, scripts (device- and
  product-level), products, monitoring and agent updates, plus a profiles
  lookup. MCP errors carry the same `{ code }` taxonomy as the CLI JSON
  mode (exposed on `_meta`) so clients can pattern-match without parsing
  human strings.
- **Subcommand-first CLI UX**: `thinr device <action> <deviceId>` /
  `thinr product <action> <productId>` replaces the previous top-level
  flag shape. Matches `kubectl` / `git` idioms.
- `thinr device list [pattern]` with case-insensitive regex filtering on
  the server side (replaces the old `thinr devices`).
- `thinr device exec <deviceId> <command...>` with streaming stdout/stderr,
  SIGINT cancellation, `--json` envelope, and `--legacy` one-shot fallback
  for older agents.
- `thinr device update check|apply` for managing agent upgrades.
- `thinr device resource` with per-resource input/output schema
  introspection, and `thinr product resource` / `thinr product property`
  for fleet fan-outs.
- **Multi-profile configuration store** (`~/.config/thinr-cli/config.json`):
  one profile per server, selected via `--profile`, the `THINR_PROFILE`
  env var, or a per-call MCP parameter. Legacy single-file configs are
  detected and migrated in-memory on read.
- `thinr profile list|current|use|delete` for managing configured
  environments.
- `--json` / `-j` output envelope on every data-producing command with a
  stable `{ code }` taxonomy: `not_configured`, `not_found`,
  `unauthorized`, `server_error`, `network_error`, `input_error`,
  `timeout`, `cancelled`, `error`.
- `-u, --user` admin impersonation flag plumbed through every
  device-scoped operation (CLI + MCP).
- `THINR_INSECURE=1` env var to accept self-signed TLS certificates
  against non-localhost hosts (localhost / 127.0.0.1 are always
  accepted).
- Device property setter via PUT (`setDeviceProperty` in the CLI,
  `thinr_property_set` in MCP).
- `thinr_device_info` MCP tool surfaces server-side product, asset group
  and description alongside the agent's own `system_info`.
- Refresh-token flow on 401s: the CLI transparently swaps expired access
  tokens for a fresh one when a `refresh_token` is on record, and fails
  cleanly (with an actionable `unauthorized` error) when it isn't.

### Changed

- **MCP server internals**: tool schema and handler now paired in a
  registry, so they cannot drift apart. Tools grouped by area under
  `lib/mcp/tools-*.js`, with `server.js` reduced to a thin bootstrap.
- **CLI `device` command** split into one file per subcommand under
  `commands/device/` (previously a single 17 KB module).
- `lib/device.js` renamed to `lib/devices.js` (plural: operations on the
  fleet), paired with the low-level `lib/device-api.js`.
- Interactive handlers (auth / console / proxy) no longer call
  `process.exit` from `lib/*`; the CLI entry owns the exit code.
- Centralised API error classification in `lib/errors.js` — one
  `{ message, code, status }` contract consumed by both CLI JSON mode
  and MCP `_meta`.
- Re-thrown auth errors chain the original `cause` for better
  debugging.
- Bad `-i key=value` values surface as a clean Commander
  `InvalidArgumentError` instead of a stack trace.
- Node.js engine requirement bumped to **`>=18`**; `.nvmrc` pinned to 20.

### Removed

- `thinr devices` (use `thinr device list` instead).
- `thinr device mcp <deviceId>` (use `thinr mcp` with per-call `device`
  parameter).
- `thinr device env` launcher.

### Tooling

- ESLint 10 (flat config) + Prettier 3 with `eslint-config-prettier`
  bridge. Scripts: `npm run lint` / `lint:fix` / `format` /
  `format:check`.
- TypeScript `checkJs` via per-file `// @ts-check` opt-in; 21 files
  under `lib/mcp/` and `commands/device/` pass type-check today. Script:
  `npm run typecheck`.
- Unit tests with `node --test` (zero deps): MCP registry invariants +
  error helpers. Script: `npm test`.

## [1.0.2] - 2025-07-21

### Fixed

- Fixed import on proxy command
- Updated commands in readme

### Removed

- Removed targetSecure option from device proxy command
- Avoid deleting token from server on logout

## [1.0.1] - 2025-07-21

### Fixed

- Fixed configuration not found error

## [1.0.0] - 2025-06-20

### Added

- Initial release of ThinR CLI, a command-line interface for managing remote devices
- OAuth device flow authentication
- Device and product management commands
- Remote terminal access
- Proxy creation
- Device status checks
- Property listing and retrieval
- Device resource listing and execution

[1.1.0]: https://github.com/Thin-Remote/thinr-cli/compare/1.0.2...1.1.0
[1.0.2]: https://github.com/Thin-Remote/thinr-cli/compare/1.0.1...1.0.2
[1.0.1]: https://github.com/Thin-Remote/thinr-cli/compare/1.0.0...1.0.1
[1.0.0]: https://github.com/Thin-Remote/thinr-cli/tag/1.0.0
