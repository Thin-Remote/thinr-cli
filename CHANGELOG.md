# Changelog

## [Unreleased]

### Added

- MCP: `thinr_push` and `thinr_pull` — upload a local file to a
  device and download a remote file to local disk, respectively.
  Rounds out filesystem parity with the CLI so an agent can move
  binary or large payloads that don't fit inline in `thinr_write`.

### Changed

- Unified filesystem verbs across CLI, MCP and playbooks so the same
  eight nouns mean the same thing everywhere: `read` / `write`
  (inline content) · `push` / `pull` (local ↔ remote file transfer)
  · `ls` · `mkdir` · `rm` · `mv`.
- CLI: `thinr device cat` is now `thinr device read` (`cat` kept as
  a hidden alias). New `thinr device write <deviceId> <path>
  [content]` accepts the payload as an argument or on stdin.
- MCP: `thinr_delete` renamed to `thinr_rm`, `thinr_move` renamed to
  `thinr_mv`. No backwards-compatibility aliases.
- Playbook actions: `delete` → `rm`, `move` → `mv`. The `write`
  action now only accepts inline `content`; use the new `push`
  action to upload a local file (`source`, `destination`). New
  `pull` action downloads a remote file to the local disk.

## [1.2.0] - 2026-04-16

### Added

- `thinr product exec <productId> <command...>` — run a shell command
  in parallel on every active device of a product, with bounded
  concurrency (`-c, --concurrency`, default 10), per-device timeout
  (`--timeout`, default 30 s), `--fail-fast`, asset-group filter
  (`-g, --group`) and an `-a, --all` switch to include offline
  devices. Live progress shows a single spinner with done/total
  counters; the final render uses a `cli-table3` table per device
  plus a compact `Output:` section and a one-line totals bar.
- `thinr_product_exec` MCP tool — the same fan-out as the CLI
  subcommand, returning a consolidated text report so an AI agent
  can roll out a change across a whole fleet in a single call
  instead of looping `thinr_exec` per device.
- `lib/concurrency.js#runPool` — tiny helper used by both entry
  points; keeps at most N workers in flight and returns a parallel
  results array. `runPool` plus an internal try/catch in each worker
  keeps fleet-wide errors localised per device.

### Changed

- `cli-table3` added as a direct dependency to render the
  product-exec summary.

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
- The MCP server's `initialize` response now reports the CLI's
  `package.json` version in `serverInfo.version` (was hardcoded).
- Runtime dependencies refreshed, including majors: `@inquirer/prompts`
  7 → 8, `conf` 14 → 15, `open` 10 → 11, `ora` 8 → 9. All npm audit
  advisories cleared (0 vulnerabilities on install).

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
- Publish pipeline migrated from a long-lived `NPM_TOKEN` secret to npm
  Trusted Publishing (OIDC), with `--provenance` attestations on every
  publish. GitHub Actions bumped to `checkout@v5` / `setup-node@v5`.

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

[1.2.0]: https://github.com/Thin-Remote/thinr-cli/compare/1.1.0...1.2.0
[1.1.0]: https://github.com/Thin-Remote/thinr-cli/compare/1.0.2...1.1.0
[1.0.2]: https://github.com/Thin-Remote/thinr-cli/compare/1.0.1...1.0.2
[1.0.1]: https://github.com/Thin-Remote/thinr-cli/compare/1.0.0...1.0.1
[1.0.0]: https://github.com/Thin-Remote/thinr-cli/tag/1.0.0
